import { describe, expect, it } from 'vitest';
import { ACCEPTED_CHECK_FAILS, acceptedFails, acceptedKey } from './accepted';

describe('accepted FAILs', () => {
  it('refuses an entry whose reason is empty or blank', () => {
    expect(() => acceptedFails({ 'pacing:fire @ 10 min': '' })).toThrow(
      "Accepted check FAIL 'pacing:fire @ 10 min' has no reason: give one, or drop the entry",
    );
    expect(() =>
      acceptedFails({ 'centerShare:fire': 'B1 tuning, Hoshi 10/28', 'newbie:all @ 10 min': ' \t' }),
    ).toThrow(/'newbie:all @ 10 min' has no reason/);
    const table = { 'centerShare:fire': 'B1 tuning, Hoshi 10/28' };
    expect(acceptedFails(table)).toBe(table);
    expect(() => acceptedFails(ACCEPTED_CHECK_FAILS)).not.toThrow();
  });

  it("keys a result by its check and subject, as ACCEPTED_CHECK_FAILS' entries are", () => {
    expect(acceptedKey({ id: 'pacing', subject: 'fire @ 10 min' })).toBe('pacing:fire @ 10 min');
    expect(acceptedKey({ id: 'budget', subject: 'fire × effectsDropped' })).toBe(
      'budget:fire × effectsDropped',
    );
  });
});
