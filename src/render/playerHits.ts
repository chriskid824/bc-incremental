/**
 * Which of a tick's events flash the core (docs/v3 C7 design §2.9; C7.2's hand-off to C7.8): a
 * contact (playerHit) or a bullet (bulletHit) that reached life does; one the shield took whole
 * does not. The sim pushes shieldAbsorbed immediately before the hit it absorbed
 * (src/sim/systems/contact.ts damagePlayer), so a hit of damage 0 right after a shieldAbsorbed is
 * the shield's alone. An M1 run has no shield, so every playerHit flashes, as before. DOM-free,
 * so the tests reach it.
 */

import type { SimEvent } from '../sim';

export class CoreHitFilter {
  /** The last event was a shieldAbsorbed: the next playerHit or bulletHit is the one it took. */
  private absorbed = false;

  /**
   * Whether `event` flashes the core; give it each tick's playerHit, bulletHit and shieldAbsorbed
   * events, in order (any other event leaves the mark as it is).
   */
  flashes(event: SimEvent): boolean {
    switch (event.type) {
      case 'shieldAbsorbed':
        this.absorbed = true;
        return false;
      case 'playerHit':
      case 'bulletHit': {
        const whole = this.absorbed && event.damage === 0;
        this.absorbed = false;
        return !whole;
      }
      default:
        return false;
    }
  }

  /** Forgets a shieldAbsorbed left over: a new run. */
  reset(): void {
    this.absorbed = false;
  }
}
