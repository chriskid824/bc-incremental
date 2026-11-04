import { describe, expect, it } from 'vitest';
import type { SimState } from '../../sim/types';
import { ControlTally } from './controlTally';

describe('ControlTally', () => {
  it('counts freezes but a boss meter, and shatters, until reset', () => {
    const tally = new ControlTally();
    tally.handleEvents([
      { type: 'freeze', targetId: 1, boss: false },
      { type: 'freeze', targetId: 2, boss: true },
      { type: 'shatter', x: 0, y: 0, radius: 40 },
      { type: 'waveStarted', wave: 2 },
    ]);
    tally.handleEvents([{ type: 'freeze', targetId: 3, boss: false }]);
    expect(tally.counts).toEqual({ freezes: 2, shatters: 1, slowedShare: 0 });
    tally.reset();
    expect(tally.counts).toEqual({ freezes: 0, shatters: 0, slowedShare: 0 });
  });

  it('shares live enemy time chilled, frozen or zone-slowed', () => {
    const enemy = (o: Record<string, unknown>) => ({
      alive: true,
      boss: false,
      frost: 0,
      frozenUntil: 0,
      zoneSlow: 0,
      zoneSlowUntil: 0,
      ...o,
    });
    const state = {
      tick: 100,
      enemies: [
        enemy({ frost: 0.2 }),
        enemy({ frozenUntil: 120 }),
        enemy({ zoneSlow: 0.3, zoneSlowUntil: 101 }),
        enemy({ zoneSlow: 0.3, zoneSlowUntil: 90 }),
        enemy({ alive: false, frost: 1 }),
      ],
    } as unknown as SimState;
    const tally = new ControlTally();
    tally.observe(state);
    expect(tally.counts.slowedShare).toBe(0.75);
  });
});
