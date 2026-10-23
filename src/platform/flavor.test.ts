import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../vite.config';
import { FLAVOR, parseFlavor } from './flavor';

/** vite.config.ts' config for `mode`, as `vite build --mode <mode>` resolves it. */
const configFor = (mode: string) => viteConfig({ command: 'build', mode });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseFlavor', () => {
  it('reads unset, empty and full as the full game, and demo as the demo', () => {
    expect(parseFlavor(undefined)).toBe('full');
    expect(parseFlavor('')).toBe('full');
    expect(parseFlavor('full')).toBe('full');
    expect(parseFlavor('demo')).toBe('demo');
  });

  it('throws on anything else, naming the allowed values', () => {
    for (const raw of ['Demo', 'DEMO', 'Full', ' demo', 'demo ', 'trial', 'steam', '0', 'false']) {
      expect(() => parseFlavor(raw), raw).toThrow(
        `VITE_FLAVOR must be 'demo' or 'full' (or unset, for full), not '${raw}'`,
      );
    }
  });
});

describe('FLAVOR', () => {
  it("is this build's VITE_FLAVOR, read when the module loads", async () => {
    expect(FLAVOR).toBe(parseFlavor(process.env.VITE_FLAVOR));
    vi.stubEnv('VITE_FLAVOR', 'demo');
    vi.resetModules();
    expect((await import('./flavor')).FLAVOR).toBe('demo');
    vi.stubEnv('VITE_FLAVOR', 'trial');
    vi.resetModules();
    await expect(import('./flavor')).rejects.toThrow("not 'trial'");
  });
});

describe('vite.config.ts', () => {
  it('fails the build on a VITE_FLAVOR other than demo or full', () => {
    vi.stubEnv('VITE_FLAVOR', 'trial');
    expect(() => configFor('production')).toThrow("not 'trial'");
    expect(() => configFor('steam')).toThrow("not 'trial'");
    vi.stubEnv('VITE_FLAVOR', 'demo');
    expect(() => configFor('production')).not.toThrow();
  });

  it('builds the steam mode into dist-steam and every other mode into dist', () => {
    expect(configFor('steam').build?.outDir).toBe('dist-steam');
    expect(configFor('production').build?.outDir).toBe('dist');
    expect(configFor('development').build?.outDir).toBe('dist');
  });
});
