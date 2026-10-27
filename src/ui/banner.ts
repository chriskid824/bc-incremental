/**
 * The first-appearance banner (docs/v3 C7 design §2.9 with the lead's ruling L7; gd A.3 「新敵人
 * 登場：第一次出現時畫面上方滑出一行說明…2.5 秒後收起，不暫停」). The first enemySpawned of a type
 * its caller has not seen slides one line in from the top, `banner.enemy.<id>` with the numbers of
 * that type's behaviour, and closes BANNER_MS later. Seen is per profile (L7), not per run: the
 * caller passes the types already seen (account.seenEnemies on B1's character page, a fresh set
 * per page load on `?enemies`) and hears each new sighting through `onSighting`, which records it
 * (recordSeenEnemies on B1's page). Every type is reported the first tick it spawns, the six M1
 * types too; only the v3 types the waves bring have a line (BANNER_KEYS). Several new types in one
 * tick queue in sighting order and show one line at a time, BANNER_GAP_MS apart (the lead's
 * default). The banner reads events and wall-clock frame time and owns no loop, so it cannot
 * pause the sim: its caller's ticks go on while a line shows. A line's time starts with the
 * frame after the one that showed it, so a long frame (the first one back from a hidden tab)
 * cannot close a line before it is ever painted, which would lose it for good. DOM-free, so
 * the tests reach it; src/ui/bannerView.ts is the line on the page.
 */

import type { EnemyDef, EnemyId } from '../data/types';
import { t } from '../i18n';
import type { MessageKey, MessageValues } from '../i18n';
import type { SimEvent } from '../sim/types';
import { enemyPlural } from './runEnd';

/** A line's time on screen, wall clock (gd A.3 「2.5 秒後收起」). */
export const BANNER_MS = 2500;
/** Between two queued lines: the slide out and back in (.bc-banner's 250 ms) and a beat (初始值). */
export const BANNER_GAP_MS = 350;

/** The line of every v3 type the waves bring (wavesV3.ts: their rules, treasure and boss). */
export const BANNER_KEYS: Readonly<Partial<Record<EnemyId, MessageKey>>> = {
  shielder: 'banner.enemy.shielder',
  regenerator: 'banner.enemy.regenerator',
  dasher: 'banner.enemy.dasher',
  shooter: 'banner.enemy.shooter',
  summoner: 'banner.enemy.summoner',
  treasure: 'banner.enemy.treasure',
  onion: 'banner.enemy.onion',
};

/** Where the banner shows its line: src/ui/bannerView.ts, or a stub in the tests. */
export interface BannerView {
  show(text: string): void;
  hide(): void;
}

/** A share as a percentage, and a number, without float noise (0.15 is 15, not 15.000000000000002). */
const percent = (share: number): string => decimal(share * 100);
const decimal = (x: number): string => String(Number(x.toFixed(2)));

/** The numbers of a def's line, from its behaviour, so a tuned number never leaves the text stale. */
function valuesOf(def: EnemyDef): MessageValues {
  const b = def.behaviour;
  switch (b?.kind) {
    case 'shield':
      return { pct: percent(b.blockBelowPct) };
    case 'regen':
      return { pct: percent(b.lifePctPerSec) };
    case 'dash':
      return { sec: decimal(b.chargeSec), mult: decimal(b.dashMult) };
    case 'shoot':
      return { sec: decimal(b.periodSec) };
    case 'summon':
      return { sec: decimal(b.periodSec), count: b.count, enemies: enemyPlural(b.enemy) };
    case 'treasure':
      return { sec: decimal(b.orbitSec), mult: decimal(def.dropMult) };
    case 'layers':
      return { layers: b.layers, enemies: enemyPlural(b.burst.enemy) };
    case undefined:
      return {};
  }
}

/** The banner line of `def`'s type in the current locale; null for a type without one. */
export function bannerText(def: EnemyDef): string | null {
  const key = BANNER_KEYS[def.id];
  return key === undefined ? null : t(key, valuesOf(def));
}

export class EnemyBanner {
  private readonly seen: Set<EnemyId>;
  /** Sighted types whose line has not shown yet, in sighting order. */
  private readonly queue: EnemyId[] = [];
  private current: EnemyId | null = null;
  /** The current line's time left on screen. */
  private leftMs = 0;
  /** The current line showed this frame: its time starts next frame. */
  private fresh = false;
  /** The gap left before the next queued line may show. */
  private gapMs = 0;

  /**
   * `seen`: the types the caller has seen already, copied. `onSighting`: called once for each
   * type seen here for the first time, in sighting order.
   */
  constructor(
    private readonly enemies: Readonly<Record<EnemyId, EnemyDef>>,
    seen: Iterable<EnemyId>,
    private readonly view: BannerView,
    private readonly onSighting: (id: EnemyId) => void = () => undefined,
  ) {
    this.seen = new Set(seen);
  }

  /** The type whose line shows now; null between lines. */
  get showing(): EnemyId | null {
    return this.current;
  }

  /** One tick's events: each enemySpawned of a type not seen yet is a sighting. */
  events(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      if (event.type === 'enemySpawned') this.sighted(event.enemy);
    }
  }

  /** `id` spawned: reported and queued the first time only. */
  sighted(id: EnemyId): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.onSighting(id);
    if (BANNER_KEYS[id] === undefined) return;
    this.queue.push(id);
    this.next();
  }

  /** A frame of `elapsedMs` wall-clock ms: the line closes once its time is up, the next follows. */
  update(elapsedMs: number): void {
    const elapsed = Math.max(0, elapsedMs);
    if (this.current !== null) {
      if (this.fresh) {
        this.fresh = false;
        return;
      }
      this.leftMs -= elapsed;
      if (this.leftMs > 0) return;
      this.current = null;
      this.view.hide();
      this.gapMs = BANNER_GAP_MS;
      return;
    }
    this.gapMs = Math.max(0, this.gapMs - elapsed);
    this.next();
    this.fresh = false;
  }

  /** Shows the first queued line when none shows and the gap is over. */
  private next(): void {
    if (this.current !== null || this.gapMs > 0) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.current = id;
    this.leftMs = BANNER_MS;
    this.fresh = true;
    this.view.show(bannerText(this.enemies[id]) ?? '');
  }
}
