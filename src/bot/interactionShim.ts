// A minimal stand-in for discord.js's ChatInputCommandInteraction, backed by
// Discord's HTTP Interactions endpoints instead of a live gateway
// connection. Implements exactly the surface the 18 command files actually
// use (grep-verified against src/bot/commands/*.ts) — not a general-purpose
// discord.js replacement.
//
// The FIRST ack (deferReply/reply/deferUpdate) is NOT sent via its own fetch
// call — Discord requires that ack within 3 seconds, delivered as the direct
// HTTP response to its webhook POST, not just via a side-channel REST call.
// interactions.ts awaits `shim.firstAck` and returns it as the Hono
// response body itself, which is the one part of this protocol with no
// ambiguity in Discord's docs. Everything after the first ack (editReply,
// and a second reply()/deferReply() if a command calls one twice) has no
// such timing constraint and goes through plain REST calls.
import { fetchGuildMember, type DiscordMember } from './discordRest.js';

const API_BASE = 'https://discord.com/api/v10';

interface RawOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

export interface RawInteraction {
  id: string;
  token: string;
  application_id: string;
  type: number;
  data?: {
    name: string;
    options?: RawOption[];
    resolved?: { users?: Record<string, { id: string; username: string }> };
    custom_id?: string;
  };
  member?: { user: { id: string; username: string; bot?: boolean } };
  user?: { id: string; username: string };
  guild_id?: string;
}

export interface ShimGuild {
  id: string;
  members: {
    fetch(userId: string): Promise<DiscordMember | null>;
  };
}

/** Reply payload shape used across every command file (embeds + optional flags). */
export interface ReplyPayload {
  embeds?: unknown[];
  components?: unknown[];
  content?: string;
  ephemeral?: boolean;
}

const EPHEMERAL_FLAG = 1 << 6;

export class InteractionShim {
  readonly commandName: string;
  readonly guildId: string | null;
  readonly guild: ShimGuild | null;
  readonly user: { id: string; username: string };
  deferred = false;
  replied = false;

  /** Resolves with the exact JSON body interactions.ts should return to Discord. */
  readonly firstAck: Promise<unknown>;
  private resolveFirstAck!: (payload: unknown) => void;
  private firstAckSent = false;

  private raw: RawInteraction;
  private botToken: string;

  constructor(raw: RawInteraction, botToken: string) {
    this.raw = raw;
    this.botToken = botToken;
    this.commandName = raw.data?.name ?? '';
    this.guildId = raw.guild_id ?? null;
    this.user = raw.member?.user ?? raw.user ?? { id: '', username: '' };
    this.guild = this.guildId
      ? {
          id: this.guildId,
          members: {
            fetch: (userId: string) => fetchGuildMember(this.guildId!, userId, this.botToken),
          },
        }
      : null;
    this.firstAck = new Promise((resolve) => {
      this.resolveFirstAck = resolve;
    });
  }

  /** custom_id of the component that triggered this interaction (buttons only). */
  get customId(): string | undefined {
    return this.raw.data?.custom_id;
  }

  options = {
    getString: ((name: string, required?: boolean): string | null => {
      const opt = this.raw.data?.options?.find((o) => o.name === name);
      const value = typeof opt?.value === 'string' ? opt.value : undefined;
      if (required && value === undefined) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value ?? null;
    }) as {
      (name: string, required: true): string;
      (name: string, required?: false): string | null;
    },
    getUser: ((name: string, required?: boolean): { id: string; username: string } | null => {
      const opt = this.raw.data?.options?.find((o) => o.name === name);
      const id = typeof opt?.value === 'string' ? opt.value : undefined;
      if (required && id === undefined) {
        throw new Error(`Missing required option: ${name}`);
      }
      if (!id) return null;
      return this.raw.data?.resolved?.users?.[id] ?? { id, username: 'unknown' };
    }) as {
      (name: string, required: true): { id: string; username: string };
      (name: string, required?: false): { id: string; username: string } | null;
    },
    getInteger: ((name: string, required?: boolean): number | null => {
      const opt = this.raw.data?.options?.find((o) => o.name === name);
      const value = typeof opt?.value === 'number' ? opt.value : Number.parseInt(String(opt?.value ?? ''), 10);
      if (required && !Number.isFinite(value)) {
        throw new Error(`Missing required option: ${name}`);
      }
      return Number.isFinite(value) ? value : null;
    }) as {
      (name: string, required: true): number;
      (name: string, required?: false): number | null;
    },
  };

  /** Send (or queue) the given payload as the interaction's first ack. */
  private sendFirstAck(payload: unknown): void {
    if (this.firstAckSent) return; // a command double-acking — ignore, not fatal
    this.firstAckSent = true;
    this.resolveFirstAck(payload);
  }

  async deferReply(opts?: { ephemeral?: boolean }): Promise<void> {
    this.sendFirstAck({
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      data: opts?.ephemeral ? { flags: EPHEMERAL_FLAG } : undefined,
    });
    this.deferred = true;
  }

  /** Acknowledge a component interaction (button click) without a visible reply. */
  async deferUpdate(): Promise<void> {
    this.sendFirstAck({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
    this.replied = true;
  }

  async reply(payload: ReplyPayload): Promise<void> {
    if (!this.firstAckSent) {
      this.sendFirstAck({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: {
          content: payload.content,
          embeds: payload.embeds,
          components: payload.components,
          flags: payload.ephemeral ? EPHEMERAL_FLAG : undefined,
        },
      });
      this.replied = true;
      return;
    }
    // The interaction was already acked (e.g. reply() called after
    // deferReply()) — Discord no longer accepts a fresh ack at this point.
    // Send it as a followup message instead of silently dropping it.
    const res = await fetch(`${API_BASE}/webhooks/${this.raw.application_id}/${this.raw.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        flags: payload.ephemeral ? EPHEMERAL_FLAG : undefined,
      }),
    });
    if (!res.ok) {
      // fetch never throws on HTTP errors — without this check a Discord
      // 4xx/5xx here means the user simply never sees the reply, with no
      // trace (the exact "stuck on thinking" incident class).
      console.error(`[shim] followup POST failed http=${res.status} — reply lost`);
    }
    this.replied = true;
  }

  async editReply(payload: ReplyPayload): Promise<void> {
    // Editing only makes sense after the first ack has actually gone out —
    // wait for it so a command that races deferReply()/editReply() (none do
    // today, but nothing enforces it) can't PATCH a message before Discord
    // has created it.
    await this.firstAck;
    const res = await fetch(`${API_BASE}/webhooks/${this.raw.application_id}/${this.raw.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
      }),
    });
    if (!res.ok) {
      // Same class as the followup POST: a failed PATCH leaves the user on
      // "Bot is thinking…" forever. editOriginalReply-style booleans are
      // checked at every call site — this internal one must be too.
      console.error(`[shim] editReply PATCH failed http=${res.status} — user stuck on thinking`);
    }
    this.replied = true;
  }
}
