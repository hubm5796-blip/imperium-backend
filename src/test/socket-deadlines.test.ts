/**
 * GLM-4/GLM-5 — socket read deadlines + unhandledrejection visibility.
 *
 * GLM-4: mysqlWire's WireStream.fill and redisSocket's ChunkReader.fill read
 * raw TCP with NO deadline — a stalled remote hung the invocation until
 * workerd killed it. Both now race their reads through readWithDeadline.
 * Its contract (and crash-safety — the 1101 class this repo knows well):
 *   - a resolved read passes through untouched;
 *   - a stalled read rejects with the labeled timeout error;
 *   - the LOSING promise's later rejection never becomes an unhandled
 *     rejection (vitest fails the run on one — the trailing await proves it);
 *   - a fast loser rejection doesn't fire the deadline after cleanup.
 *
 * GLM-5: the 1101 crash guard used to preventDefault in total silence. The
 * extracted handler must log (structured console.error via logger), report
 * through the staff pipeline (rate-capped alertError), and still mark the
 * event handled — even when logging itself throws.
 */
import { describe, expect, it, vi } from 'vitest';
import { readWithDeadline } from '../db/readDeadline.js';
import { handleUnhandledRejection } from '../utils/unhandledRejection.js';

describe('GLM-4: readWithDeadline', () => {
  it('passes a resolved read through untouched', async () => {
    await expect(readWithDeadline(Promise.resolve({ done: false, value: new Uint8Array([1]) }), 100, 't')).resolves.toEqual({
      done: false,
      value: new Uint8Array([1]),
    });
  });

  it('rejects a stalled read with the labeled timeout error', async () => {
    const never = new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
    await expect(readWithDeadline(never, 10, 'mysql-wire')).rejects.toThrow(
      /mysql-wire: socket read timed out after 10ms/,
    );
  });

  it('the losing read rejecting LATER does not become an unhandled rejection', async () => {
    let rejectRead!: (e: Error) => void;
    const read = new Promise<{ done: boolean }>((_res, rej) => { rejectRead = rej; });
    const attempt = readWithDeadline(read, 5, 'redis-socket');
    await expect(attempt).rejects.toThrow(/timed out/);
    // The socket tears down 20ms AFTER the deadline already won. If the
    // helper did not pre-attach a catch, this rejection would be unhandled
    // and vitest would fail the run (workerd: error 1101).
    setTimeout(() => rejectRead(new Error('socket closed')), 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(true).toBe(true);
  });

  it('a fast read rejection surfaces promptly (no masked failures)', async () => {
    await expect(
      readWithDeadline(Promise.reject(new Error('socket closed mid-packet')), 100, 't'),
    ).rejects.toThrow('socket closed mid-packet');
    // Give the (cancelled) timer a beat — no stray rejection may appear.
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe('GLM-5: handleUnhandledRejection', () => {
  it('logs the rejection, alerts staff, then marks the event handled', async () => {
    const mod = await import('../utils/unhandledRejection.js');
    const logger = (await import('../utils/logger.js')).logger;
    const alertMod = await import('../utils/errorAlerts.js');
    const alertSpy = vi.spyOn(alertMod, 'alertError').mockImplementation(() => {});
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let handled = false;
    try {
      mod.handleUnhandledRejection(new Error('dangling socket'), () => { handled = true; });
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ message: 'dangling socket' }),
        }),
        'Unhandled promise rejection captured',
      );
      expect(alertSpy).toHaveBeenCalledWith('unhandled', expect.stringMatching(/unhandledrejection: Error: dangling socket/));
      expect(handled).toBe(true);
    } finally {
      logSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  it('non-Error reasons are stringified, never crash the guard', async () => {
    const mod = await import('../utils/unhandledRejection.js');
    const logger = (await import('../utils/logger.js')).logger;
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn((await import('../utils/errorAlerts.js')), 'alertError').mockImplementation(() => {});
    let handled = false;
    try {
      mod.handleUnhandledRejection(undefined, () => { handled = true; });
      expect(handled).toBe(true);
      mod.handleUnhandledRejection(42, () => { handled = true; });
      expect(handled).toBe(true);
      mod.handleUnhandledRejection('plain string reason', () => { handled = true; });
      expect(handled).toBe(true);
    } finally {
      logSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  it('markHandled still runs when logging itself throws', async () => {
    const mod = await import('../utils/unhandledRejection.js');
    const logger = (await import('../utils/logger.js')).logger;
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => { throw new Error('sink down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let handled = false;
    try {
      mod.handleUnhandledRejection(new Error('x'), () => { handled = true; });
      expect(handled).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
