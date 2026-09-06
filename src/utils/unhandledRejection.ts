/**
 * GLM-5: the workerd 1101 crash guard (worker.ts) used to swallow every
 * unhandled promise rejection in TOTAL SILENCE — `event.preventDefault()` and
 * nothing else. Background socket failures, DB connection errors, anything
 * outside an await chain: invisible. The guard stays (a raw 1101 fails the
 * whole invocation), but a rejection is now:
 *
 *   1. logged as structured console.error (the repo's logging sink — visible
 *      via `wrangler tail` and the Cloudflare dashboard Logs tab), with the
 *      error name, message and stack;
 *   2. reported through the shared staff-alert pipeline (alertError —
 *      signature-deduped, hourly-capped, kind-allowlisted per B-38, so a
 *      rejection storm cannot become a staff-ping cannon);
 *   3. only then marked handled.
 *
 * Never throws: the handler must not take the isolate down with it.
 */
import { logger } from './logger.js';
import { alertError } from './errorAlerts.js';

export function handleUnhandledRejection(reason: unknown, markHandled: () => void): void {
  const err =
    reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' ? reason : JSON.stringify(safeShape(reason)));
  try {
    logger.error(
      {
        err: { name: err.name, message: err.message, stack: err.stack },
        reasonKind: reason instanceof Error ? 'error' : typeof reason,
      },
      'Unhandled promise rejection captured',
    );
    // Rate-capped + deduped staff visibility; alertError never throws.
    void alertError('unhandled', `unhandledrejection: ${err.name}: ${err.message}`);
  } catch {
    // Logging/alerting must never break the crash guard itself. A bare
    // console.error still leaves a trace in the dashboard logs.
    console.error('[unhandledrejection] guard failed to log', err);
  }
  markHandled();
}

/** JSON.stringify can throw (BigInt, cycles) — degrade to a type tag. */
function safeShape(reason: unknown): unknown {
  try {
    return { value: String(reason) };
  } catch {
    return { value: '[unstringifiable]' };
  }
}
