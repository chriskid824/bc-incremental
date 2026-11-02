/**
 * Small outline icons of the row enemies (docs/v3/game-design-v3.md §6.4's columns, A.5's looks)
 * for the select cards' strong and weak rows: neutral grey outlines, the treasure gold, each with
 * its name as a tooltip.
 */

import type { RowEnemy } from '../../data/web';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';

const SVG = 'http://www.w3.org/2000/svg';

/** A regular polygon's points on a radius-r circle around (12, 12), the first vertex up. */
function polygon(sides: number, r: number, turn = 0): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + turn + (i * 2 * Math.PI) / sides;
    points.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return points.join(' ');
}

/** The icon's shapes, in a 24 × 24 box. */
const SHAPES: Readonly<Record<RowEnemy, string>> = {
  triangle: `<polygon points="${polygon(3, 8)}"/>`,
  square: '<rect x="5" y="5" width="14" height="14"/>',
  pentagon: `<polygon points="${polygon(5, 9)}"/>`,
  shielder: '<circle cx="12" cy="13" r="5"/><path d="M5 8 A9 9 0 0 1 19 8"/>',
  regenerator: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  dasher: '<polygon points="12,2 16,12 12,22 8,12"/>',
  shooter: '<polygon points="7,6 17,6 21,18 3,18"/>',
  summoner:
    '<circle cx="12" cy="12" r="6"/><polygon points="12,1 13.5,3.5 10.5,3.5"/>' +
    '<polygon points="21,17 18.5,17.5 19.5,15"/><polygon points="3,17 4.5,15 5.5,17.5"/>',
  treasure: '<polygon points="12,5 17,12 12,19 7,12"/>',
  boss: `<polygon points="${polygon(6, 10, Math.PI / 6)}"/><circle cx="12" cy="12" r="3"/>`,
};

export function enemyIcon(doc: Document, enemy: RowEnemy): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'bc-game-enemy-icon');
  svg.dataset['enemy'] = enemy;
  if (enemy === 'treasure') svg.classList.add('bc-game-enemy-gold');
  svg.innerHTML = SHAPES[enemy];
  const title = doc.createElementNS(SVG, 'title');
  title.textContent = t(`web.enemy.${enemy}` as MessageKey);
  svg.prepend(title);
  return svg;
}
