// semaphore.ts — counting semaphore + global agent counter (SPEC §5).
//
// One shared semaphore caps concurrent agents; a separate counter enforces the
// run-lifetime agent cap (TOTAL_AGENT_CAP). Both are intentionally tiny and have
// no dependency on the executor — pure synchronization primitives.

import { TOTAL_AGENT_CAP } from "../types.js";

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  readonly active: number;
  readonly limit: number;
}

/**
 * Counting semaphore. `acquire()` resolves immediately while `active < limit`,
 * otherwise it queues FIFO. `release()` wakes exactly ONE waiter (no lost
 * wakeups: a released slot is either handed straight to a waiter or returned to
 * the free pool). `active` never exceeds `limit`.
 */
export function createSemaphore(limit: number): Semaphore {
  const cap = Math.max(1, Math.floor(limit));
  const waiters: Array<() => void> = [];
  let active = 0;

  return {
    get active() {
      return active;
    },
    get limit() {
      return cap;
    },
    acquire(): Promise<void> {
      if (active < cap) {
        active += 1;
        return Promise.resolve();
      }
      // No free slot: queue. The waiter inherits the slot kept "active" by the
      // releaser, so `active` stays balanced and never overshoots `cap`.
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        // Hand the slot directly to the FIFO-front waiter; `active` unchanged.
        next();
        return;
      }
      if (active > 0) {
        active -= 1;
      }
    },
  };
}

export interface Counter {
  next(): number;
  readonly count: number;
}

/**
 * Monotonic 1-based id allocator with a hard cap. `next()` returns the new id;
 * the `(cap+1)`-th call throws — the runaway backstop from SPEC §5
 * (TOTAL_AGENT_CAP = 1000).
 */
export function createCounter(cap: number): Counter {
  let count = 0;
  return {
    get count() {
      return count;
    },
    next(): number {
      if (count >= cap) {
        throw new Error("agent cap " + cap + " exceeded");
      }
      count += 1;
      return count;
    },
  };
}

export { TOTAL_AGENT_CAP };
