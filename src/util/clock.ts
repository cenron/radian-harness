// Injectable clocks. Durations use a monotonic source; wall-clock timestamps are
// recorded for humans. Tests substitute a fake clock.

export interface Clock {
  /** Wall-clock milliseconds since the epoch, for timestamps. */
  now(): number;
  /** Monotonic milliseconds, for durations and leases within one process. */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export class FakeClock implements Clock {
  private wall: number;
  private mono = 0;
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.wall = start;
  }
  now(): number {
    return this.wall;
  }
  monotonic(): number {
    return this.mono;
  }
  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
