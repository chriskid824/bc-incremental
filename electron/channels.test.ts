import { describe, expect, it } from 'vitest';
import { CHANNELS } from './channels';

describe('CHANNELS', () => {
  it("are §1.3's eleven, the check mode's six among them, each distinct", () => {
    expect(CHANNELS).toEqual({
      info: 'bc:info',
      saveRead: 'bc:save:read',
      saveWrite: 'bc:save:write',
      achUnlock: 'bc:ach:unlock',
      achIsUnlocked: 'bc:ach:is-unlocked',
      checkClear: 'bc:check:clear',
      checkOverlay: 'bc:check:overlay',
      checkSaves: 'bc:check:saves',
      checkShowSaves: 'bc:check:show-saves',
      checkReport: 'bc:check:report',
      checkErrors: 'bc:check:errors',
    });
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    const check = Object.entries(CHANNELS).filter(([key]) => key.startsWith('check'));
    expect(check.map(([, name]) => name).every((name) => name.startsWith('bc:check:'))).toBe(true);
    expect(names.filter((name) => name.startsWith('bc:check:'))).toHaveLength(6);
  });
});
