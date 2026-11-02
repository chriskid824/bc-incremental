/**
 * The hub's 24 nodes (gd:262-268), shared by every character and placed by defineHub's fixed
 * table (docs/v3 C6 design D15). Every number is an initial value for the balance simulator.
 */

import { defineHub, flat, inc, keystone, might, notable, ranked, rankedMods } from './templates';
import type { HubDef } from './web/types';

/**
 * 範圍 ranks. The area stat of the C4 Q2 (A) engine item is not on the branch yet, so this rank
 * raises area hits until it lands and the rank switches to it.
 */
const area = () => ranked('damage', 0.06, 3, 'increased', { tags: ['area'] });

export const HUB: HubDef | null = defineHub({
  // 強化∞ (M1): every rank ×1.10 to all damage.
  might: might(),
  defense: {
    ranked: [
      ranked('maxLife', 0.1, 5),
      ranked('lifeRegen', 0.004, 3, 'flat'),
      ranked('contactDamageTaken', -0.05, 4),
      ranked('maxLife', 0.1, 3),
      ranked('lifeRegen', 0.004, 3, 'flat'),
    ],
    notables: [
      // 第二條命: once a run, a death restores 50% of max life.
      notable('second-life', { modifiers: [flat('extraLives', 1)] }),
      // 波次護盾: each wave starts with a shield of 20% of max life.
      notable('wave-shield', {
        triggers: [{ on: 'waveStart', do: [{ kind: 'shield', lifePct: 0.2, capPct: 0.2 }] }],
      }),
    ],
  },
  economy: {
    ranked: [
      ranked('shardGain', 0.08, 5),
      ranked('coreGain', 0.1, 3),
      ranked('shardGain', 0.08, 4),
      ranked('toughDropMult', 0.1, 3),
    ],
    notables: [
      // 菁英賞金: elite and boss drops ×2.
      notable('elite-bounty', { modifiers: [flat('toughDropMult', 1)] }),
      // 寶藏嗅覺: treasure enemies +50% more often.
      notable('treasure-sense', { modifiers: [inc('treasureRate', 0.5)] }),
    ],
  },
  echo: {
    ranked: [
      ranked('attackSpeed', 0.05, 5),
      area(),
      rankedMods(
        [
          inc('burnDuration', 0.08),
          inc('poisonDuration', 0.08),
          inc('bleedDuration', 0.08),
          inc('freezeDuration', 0.08),
        ],
        3,
      ),
      ranked('projectileSpeed', 0.1, 3),
    ],
    notables: [
      // 多重施法: every 20th attack, the next one fires 3 times.
      notable('multicast', {
        triggers: [
          {
            on: 'nthAttack',
            every: 20,
            do: [{ kind: 'repeatAttack', count: 2, damagePct: 1, timing: 'nextAttack' }],
          },
        ],
      }),
      // 回聲: every 5th attack repeats the attack at 50%.
      notable('echo', {
        triggers: [
          { on: 'nthAttack', every: 5, do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
        ],
      }),
      // 擊殺爆炸: a kill explodes 10% of the time (radius 60, 50% damage).
      notable('kill-blast', {
        triggers: [
          {
            on: 'kill',
            when: [{ chance: 0.1 }],
            do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
          },
        ],
      }),
      // 新星: every 5 s a nova of radius 200.
      notable('nova', {
        triggers: [{ on: 'periodic', every: 5, do: [{ kind: 'nova', radius: 200, damagePct: 1 }] }],
      }),
    ],
  },
  rules: {
    keystones: [
      // 玻璃大砲 (M1): all damage ×2 (more); max life becomes 1.
      keystone('glass-cannon', { rules: [{ id: 'glassCannon', damageMore: 1 }] }),
      // 巨大化: its rule (radii ×2, counts halved) is the C4 Q2 (A) engine item; until it lands
      // the node holds no effect.
      keystone('gigantism', {}),
    ],
  },
});
