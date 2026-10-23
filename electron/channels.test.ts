import { describe, expect, it } from 'vitest';
import { CHANNELS } from './channels';

describe('CHANNELS', () => {
  it("are §1.3's five, without the check mode's (C9.2b's)", () => {
    expect(CHANNELS).toEqual({
      info: 'bc:info',
      saveRead: 'bc:save:read',
      saveWrite: 'bc:save:write',
      achUnlock: 'bc:ach:unlock',
      achIsUnlocked: 'bc:ach:is-unlocked',
    });
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.startsWith('bc:check:'))).toEqual([]);
  });
});
