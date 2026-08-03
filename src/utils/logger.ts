// Structured logging via plain console output — not pino. pino's default
// stdout writer relies on Node-specific fd/worker_thread mechanics
// (pino-pretty is a worker-thread transport) that aren't guaranteed to work
// in the Workers runtime; Cloudflare's own guidance for Workers logging is
// plain console.log/warn/error, visible via `wrangler tail` and the
// dashboard's Logs tab. This keeps the exact call signature every existing
// call site already uses (`logger.info({...context}, 'message')`,
// pino-style) so nothing else in the codebase needed to change.

type LogFields = Record<string, unknown>;

const isDev = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.NODE_ENV !== 'production';

function currentLevel(): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.LOG_LEVEL ?? 'info'
  );
}

const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: string): boolean {
  const min = LEVEL_RANK[currentLevel()] ?? LEVEL_RANK.info;
  return (LEVEL_RANK[level] ?? LEVEL_RANK.info) >= min;
}

function write(level: 'debug' | 'info' | 'warn' | 'error', fieldsOrMsg: LogFields | string, msg?: string): void {
  if (!shouldLog(level)) return;

  const fields = typeof fieldsOrMsg === 'string' ? {} : fieldsOrMsg;
  const message = typeof fieldsOrMsg === 'string' ? fieldsOrMsg : (msg ?? '');
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (isDev) {
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    sink(`[${level.toUpperCase()}] ${message}${extra}`);
  } else {
    sink(JSON.stringify({ level, time: Date.now(), msg: message, ...fields }));
  }
}

export const logger = {
  debug: (fieldsOrMsg: LogFields | string, msg?: string) => write('debug', fieldsOrMsg, msg),
  info: (fieldsOrMsg: LogFields | string, msg?: string) => write('info', fieldsOrMsg, msg),
  warn: (fieldsOrMsg: LogFields | string, msg?: string) => write('warn', fieldsOrMsg, msg),
  error: (fieldsOrMsg: LogFields | string, msg?: string) => write('error', fieldsOrMsg, msg),
};
