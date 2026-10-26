// Staggered balance checks. Each burner gets its own random timer, and a
// single queue keeps a random gap between any two checks, so the relay and
// the RPC never see two burners asked about together or on a shared beat.

export type StaggerOptions = {
  firstDelay: [number, number]; // ms range for a burner's first check
  interval: [number, number]; // ms range between checks of the same burner
  gap: [number, number]; // ms range between any two checks
  rand?: () => number;
};

export const DEFAULT_STAGGER: StaggerOptions = {
  firstDelay: [1_500, 15_000],
  interval: [45_000, 150_000],
  gap: [2_500, 6_000],
};

export class Stagger {
  private ids = new Set<string>();
  private due = new Map<string, number>();
  private queue: string[] = [];
  private lastRun = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  private readonly rand: () => number;
  private readonly check: (id: string) => Promise<void>;
  private readonly opts: StaggerOptions;

  constructor(check: (id: string) => Promise<void>, opts: StaggerOptions = DEFAULT_STAGGER) {
    this.check = check;
    this.opts = opts;
    this.rand = opts.rand ?? Math.random;
  }

  private pick([lo, hi]: [number, number]): number {
    return lo + this.rand() * (hi - lo);
  }

  /** Keeps the set of watched ids in step with `ids`. New ids get a random first check. */
  sync(ids: string[]): void {
    const now = Date.now();
    this.ids = new Set(ids);
    for (const id of [...this.due.keys()]) if (!this.ids.has(id)) this.due.delete(id);
    this.queue = this.queue.filter((id) => this.ids.has(id));
    for (const id of ids) if (!this.due.has(id) && !this.queue.includes(id)) this.due.set(id, now + this.pick(this.opts.firstDelay));
    this.arm();
  }

  /** Moves one id to the front of its own schedule (e.g. right after a payout), still respecting the gap. */
  soon(id: string): void {
    if (!this.ids.has(id) || this.queue.includes(id)) return;
    this.due.set(id, Date.now());
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.stopped || this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    for (const [id, at] of this.due) {
      if (at <= now) {
        this.due.delete(id);
        this.queue.push(id);
      }
    }
    let wait: number;
    if (this.queue.length) wait = Math.max(0, this.lastRun + this.pick(this.opts.gap) - now);
    else if (this.due.size) wait = Math.min(...this.due.values()) - now;
    else return;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, wait));
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (!this.queue.length) return this.arm();
    const id = this.queue.shift()!;
    this.busy = true;
    this.lastRun = Date.now();
    try {
      await this.check(id);
    } catch {
      // A failed check just waits for its next turn.
    } finally {
      this.busy = false;
      this.lastRun = Date.now();
    }
    if (this.stopped) return;
    // Only reschedule ids still watched (sync may have dropped it meanwhile).
    if (!this.due.has(id) && this.ids.has(id)) this.due.set(id, Date.now() + this.pick(this.opts.interval));
    this.arm();
  }
}
