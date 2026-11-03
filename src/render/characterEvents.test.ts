/**
 * The renderer's character-run wiring (B1): a v3 character run (RendererOptions.character) gets
 * its construct, arena, hit colour and attack language; the M1 page and `?hive` get none of it.
 * The Renderer needs a canvas, so its wiring is read from its source, as v3Events.test.ts does.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLAST_SPIRIT_SKIN, HIVE_DRONE_SKIN } from './drones';
import { CONSTRUCT_COLORS } from './palette';

/** Comments blanked out, so only code is read. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
const source = code(readFileSync(new URL('renderer.ts', import.meta.url), 'utf8'));

describe('the renderer on a character run', () => {
  it('makes the character layers only from options.character', () => {
    expect(source).toMatch(/const look = options\.character \?\? null;/);
    expect(source).toMatch(/this\.magma =\s*look\?\.construct === 'magmaCore'/);
    expect(source).toMatch(/this\.slashes =\s*look === null\s*\? null/);
    expect(source).toMatch(
      /this\.construct =\s*look !== null && look\.construct !== 'hive' \? new ConstructCoreView/,
    );
    expect(source).toMatch(
      /if \(look !== null\) this\.numbers\.setHitColor\(hitNumberColor\(look\)\);/,
    );
    expect(source).toMatch(
      /const backdrop = look === null \? createBackdrop\(\) : createArenaBackdrop\(look\.arena\);/,
    );
  });

  it('keeps `?hive` as it was: the hive skin, its comb and its shots; summons add the shots', () => {
    expect(source).toMatch(
      /const hive = options\.construct === 'hive' \|\| look\?\.construct === 'hive';/,
    );
    expect(source).toMatch(/\? new DroneLayer\(app\.renderer, textures\.streak\)\s*:/);
    expect(source).toMatch(
      /this\.poolShots = hive \|\| summons \? new PoolShotLayer\(textures\) : null;/,
    );
    expect(source).toMatch(/const summons = look !== null && !hive && look\.summons;/);
  });

  it('makes 蜂巢’s swarm layer and slot skins only on a hive character run', () => {
    expect(source).toMatch(
      /const swarmLook = hive && look !== null \? swarmLooks\(slotSkins\(look\)\) : null;/,
    );
    expect(source).toMatch(/this\.swarm =\s*swarmLook === null \? null : new SwarmLayer\(/);
    expect(source).toMatch(
      /new DroneLayer\(app\.renderer, textures\.streak, swarmDroneSkin\(swarmLook\)\)/,
    );
    // `?hive` and the summons on another construct keep the plain impact ring.
    expect(source).toMatch(
      /case 'impact':\s*if \(this\.swarm !== null\) \{\s*this\.swarm\.impact\([\s\S]*?\} else \{\s*this\.rings\.impact\(event\.x, event\.y, event\.radius\);/,
    );
    expect(source).toMatch(/if \(this\.swarm !== null\) this\.onTurretFire\(event\);/);
  });

  it('routes each character event to a layer that is null without a character', () => {
    expect(source).toMatch(
      /case 'lob':\s*this\.construct\?\.attack\(Math\.atan2\(event\.y - event\.fromY, event\.x - event\.fromX\)\);/,
    );
    expect(source).toMatch(
      /case 'explosion':\s*this\.magma\?\.explosion\(event\.x, event\.y, event\.radius\);/,
    );
    expect(source).toMatch(/case 'burst':\s*if \(this\.magma !== null\) this\.onBurst\(event\);/);
    expect(source).toMatch(
      /case 'slash':\s*this\.slashes\?\.add\(event\.x1, event\.y1, event\.x2, event\.y2, event\.width\);/,
    );
    expect(source).toMatch(
      /case 'pulse':\s*if \(event\.kind === 'zone' && event\.hits > 0\) this\.magma\?\.zonePulse\(event\.id\);/,
    );
    expect(source).toMatch(
      /case 'ailmentApplied':\s*if \(this\.magma !== null && event\.ailment === 'poison'\)/,
    );
    expect(source).toMatch(/case 'ailmentSpread':\s*this\.magma\?\.poisonSpread\(/);
    expect(source).toMatch(/case 'waveCleared':\s*this\.magma\?\.waveCleared\(\);/);
    expect(source).toMatch(/this\.magma\?\.flushTick\(\);/);
  });

  it('draws a nova at the player as 火環, an explode as a small blast', () => {
    const burst = /private onBurst\([^)]*\): void \{([\s\S]*?)\n {2}\}/.exec(source)?.[1];
    expect(burst).toMatch(/event\.kind === 'explode'\)\s*\{\s*magma\.smallBlast/);
    expect(burst).toMatch(/Math\.abs\(event\.x - CENTER_X\) < 1/);
    expect(burst).toMatch(/magma\.thresholdNova\(event\.x, event\.y, event\.radius\)/);
  });
});

describe('爆靈’s skin (gd §5.2: orange kites with a yellow-green tail)', () => {
  it('fills the kite in 熔核 orange and trails it in summon green; the hive’s stays green', () => {
    expect(BLAST_SPIRIT_SKIN.fill).toBe(CONSTRUCT_COLORS.magmaCore.main);
    expect(BLAST_SPIRIT_SKIN.trail).toBe(CONSTRUCT_COLORS.hive.main);
    expect([HIVE_DRONE_SKIN.fill, HIVE_DRONE_SKIN.trail]).toEqual([
      CONSTRUCT_COLORS.hive.main,
      CONSTRUCT_COLORS.hive.main,
    ]);
  });
});
