-- Season 2 S2-D04 (backend half; frontend counterpart S2-E04) — the session
-- revocation list. Backend-only (D1) — the plugin never reads or writes this.
--
-- Session JWTs live 7 days and were, until this table, unkillable: clearing
-- the auth cookie deletes the browser's copy, but the token itself still
-- verifies until exp. Revocation is keyed two ways:
--
--   jti:<token-id>  ONE specific token. Every newly signed session carries a
--                   jti claim since this deploy (signJwt); legacy tokens have
--                   none and can only be caught by the uuid key below.
--   uuid:<identity> EVERY session for an identity (discordId or mcUuid) that
--                   was ISSUED BEFORE the revocation. New logins after the
--                   revoke are unaffected — their iat is past the horizon —
--                   so this is a forced-logout, not a login ban.
--
-- expires_at_ms is the purge horizon: past it, every token a row could still
-- reject is dead by its own exp, so the row is deletable without re-opening
-- any session (jti rows: now + 7d >= any token carrying that jti; uuid rows:
-- now + 7d >= the exp of every pre-revoke token).
CREATE TABLE IF NOT EXISTS session_revocations (
  revocation_key   TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('jti', 'uuid')),
  issued_before_ms INTEGER,
  expires_at_ms    INTEGER NOT NULL,
  revoked_by       TEXT,
  reason           TEXT,
  revoked_at_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sr_expires ON session_revocations (expires_at_ms);
