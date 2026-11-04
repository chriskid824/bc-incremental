import { describe, expect, it } from 'vitest';
import { MUTED_KEY, readMuted, writeMuted } from './prefs';

function memory(): { getItem(key: string): string | null; setItem(key: string, v: string): void } {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

describe('the mute choice', () => {
  it('is off until set, and reads back what was written', () => {
    const store = memory();
    expect(readMuted(store)).toBe(false);
    writeMuted(store, true);
    expect(store.getItem(MUTED_KEY)).toBe('1');
    expect(readMuted(store)).toBe(true);
    writeMuted(store, false);
    expect(readMuted(store)).toBe(false);
  });

  it('survives a store that throws', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('quota');
      },
    };
    expect(readMuted(broken)).toBe(false);
    expect(() => writeMuted(broken, true)).not.toThrow();
  });
});
