/**
 * GLM-4: raw TCP stream reads against Redis/MySQL had NO deadline — a remote
 * that stalled or dropped silently (no TCP FIN) hung `await reader.read()`
 * forever, until the Worker invocation itself was killed. Every buffered
 * socket reader in src/db now races its reads through this helper.
 *
 * Crash-safety detail (the 1101 class this repo knows well): when the
 * deadline wins the race, the LOSING read promise is still pending and may
 * reject later (socket teardown). A rejection with no handler attached is a
 * fatal unhandledrejection in workerd — so the loser gets a no-op catch
 * attached here, before the race resolves either way. The timer is cleared
 * on every path so the timeout promise never rejects after a clean read.
 */

export interface ReadDeadline {
  <T>(read: Promise<T>): Promise<T>;
}

/** Wrap a stream read with a hard per-read deadline. */
export function readWithDeadline<T>(
  read: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  // The loser must not become an unhandled rejection later.
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: socket read timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([read, deadline]).finally(() => {
    // On every exit path the losing side's rejection is already observed
    // (read via the catch above, deadline via the race), and the timer is
    // cancelled so the deadline can never fire after a clean read.
    if (timer !== undefined) clearTimeout(timer);
  });
}
