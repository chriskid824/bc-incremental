/** Shared stylesheet for the DOM overlay (HUD, result panel), injected once. */

const STYLE_ID = 'bc-ui-style';

const CSS = `
.bc-ui {
  position: fixed;
  inset: 0;
  pointer-events: none;
  user-select: none;
  color: #e8ecf6;
  font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
}
.bc-ui button { pointer-events: auto; font: inherit; }
.bc-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #8e98b3;
}
.bc-hud-wave { position: absolute; top: 18px; left: 24px; }
.bc-hud-wave-number { font-size: 44px; font-weight: 800; line-height: 1.05; }
.bc-hud-sub { font-size: 16px; color: #b6bfd6; margin-top: 2px; }
.bc-hud-life {
  position: absolute;
  top: 22px;
  left: 50%;
  transform: translateX(-50%);
  width: min(380px, 40vw);
  text-align: center;
}
.bc-hud-life-row { display: flex; justify-content: space-between; align-items: baseline; }
.bc-hud-life-value { font-size: 16px; font-weight: 600; }
.bc-bar {
  margin-top: 6px;
  height: 14px;
  border-radius: 7px;
  background: rgba(10, 12, 18, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.bc-bar-fill {
  height: 100%;
  width: 100%;
  background: linear-gradient(90deg, #ff4d6d, #ff8fa3);
  transform-origin: left center;
  transition: transform 120ms linear;
}
.bc-hud-currency {
  position: absolute;
  top: 18px;
  right: 24px;
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 14px;
  row-gap: 2px;
  align-items: baseline;
  text-align: right;
}
.bc-hud-currency-value { font-size: 24px; font-weight: 700; }
.bc-hud-speed {
  position: absolute;
  right: 24px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.bc-speed-buttons { display: flex; gap: 6px; }
.bc-speed-button {
  min-width: 52px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(14, 17, 26, 0.85);
  color: #c8d0e4;
  font-size: 17px;
  font-weight: 700;
  cursor: pointer;
}
.bc-speed-button:hover { border-color: rgba(159, 232, 255, 0.6); }
.bc-speed-button[aria-pressed='true'] {
  background: #9fe8ff;
  border-color: #9fe8ff;
  color: #0b0d12;
  text-shadow: none;
}
.bc-result {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(5, 6, 10, 0.5);
  pointer-events: auto;
  cursor: pointer;
  opacity: 0;
  transition: opacity 160ms ease-out;
}
.bc-result[hidden] { display: none; }
.bc-result.bc-visible { opacity: 1; }
.bc-result-card {
  width: min(460px, calc(100vw - 48px));
  padding: 26px 30px 22px;
  border-radius: 14px;
  background: rgba(14, 17, 26, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
}
.bc-result-title { font-size: 32px; font-weight: 800; margin: 2px 0 16px; }
.bc-result-title[data-reason='death'] { color: #ff6b81; }
.bc-result-title[data-reason='timeout'] { color: #fff1a0; }
.bc-result-title[data-reason='waveCap'] { color: #9fe8ff; }
.bc-result-rows {
  display: grid;
  grid-template-columns: 1fr auto;
  row-gap: 8px;
  column-gap: 16px;
  font-size: 18px;
}
.bc-result-rows dt { color: #a3adc6; }
.bc-result-rows dd { margin: 0; font-weight: 700; text-align: right; }
.bc-result-next { margin-top: 18px; font-size: 15px; color: #8e98b3; text-align: center; }
.bc-result-actions { display: flex; gap: 10px; margin-top: 18px; }
.bc-result-actions .bc-button { flex: 1; }
.bc-result-hint { margin-top: 14px; font-size: 15px; color: #ffe27a; text-align: center; }
.bc-button {
  pointer-events: auto;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(22, 27, 40, 0.95);
  color: #e8ecf6;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  text-shadow: none;
}
.bc-button:hover { border-color: rgba(159, 232, 255, 0.7); }
.bc-button-primary { background: #9fe8ff; border-color: #9fe8ff; color: #0b0d12; }
.bc-button-primary:hover { background: #c4f2ff; }
.bc-button-quiet { background: transparent; color: #a3adc6; font-weight: 600; }
.bc-button-glow { animation: bc-glow 1.2s ease-in-out infinite alternate; }
@keyframes bc-glow {
  from { box-shadow: 0 0 0 rgba(255, 226, 122, 0); }
  to { box-shadow: 0 0 18px rgba(255, 226, 122, 0.75); }
}
.bc-talents {
  position: absolute;
  inset: 0;
  background: rgba(6, 8, 13, 0.92);
  pointer-events: auto;
}
.bc-talents[hidden] { display: none; }
.bc-talents-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
.bc-talents-svg:active { cursor: grabbing; }
.bc-talents-header { position: absolute; top: 18px; left: 24px; pointer-events: none; }
.bc-talents-title { font-size: 32px; font-weight: 800; }
.bc-talents-help { font-size: 15px; color: #8e98b3; margin-top: 4px; }
.bc-talents-card {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 270px;
  padding: 18px 18px 16px;
  border-radius: 14px;
  background: rgba(14, 17, 26, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bc-talents-currencies {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 12px;
  row-gap: 2px;
  align-items: baseline;
}
.bc-talents-currency { font-size: 24px; font-weight: 800; text-align: right; }
.bc-talents-wave-value { font-size: 17px; font-weight: 700; margin: 2px 0 4px; }
.bc-talents-wave-input { width: 100%; pointer-events: auto; accent-color: #9fe8ff; }
.bc-talents-warning {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 176, 64, 0.1);
  border: 1px solid rgba(255, 190, 90, 0.4);
  color: #ffd08a;
  font-size: 13px;
  line-height: 1.35;
}
.bc-talents-build {
  display: grid;
  grid-template-columns: 1fr auto;
  row-gap: 3px;
  column-gap: 10px;
  margin: 0;
  font-size: 14px;
}
.bc-talents-build dt { color: #a3adc6; }
.bc-talents-build dd { margin: 0; font-weight: 700; text-align: right; }
.bc-talent-link { stroke: #2a3248; stroke-width: 5; }
.bc-talent-link[data-state='open'] { stroke: #4a5675; }
.bc-talent-link[data-state='lit'] { stroke: #d9e3ff; }
.bc-talent-node { cursor: pointer; --c: #b6bfd6; }
.bc-talent-node[data-archetype='crit'] { --c: #ffd84d; }
.bc-talent-node[data-archetype='dot'] { --c: #ff7a2e; }
.bc-talent-node[data-archetype='chain'] { --c: #5ff4ff; }
.bc-talent-node[data-archetype='hybrid'] { --c: #c58bff; }
.bc-talent-shape { fill: #141927; stroke: #39425c; stroke-width: 4; }
.bc-talent-node[data-state='reachable'] .bc-talent-shape { stroke: var(--c); stroke-opacity: 0.45; }
.bc-talent-node[data-state='available'] .bc-talent-shape {
  stroke: var(--c);
  stroke-width: 6;
  filter: drop-shadow(0 0 8px var(--c));
  animation: bc-node-pulse 1s ease-in-out infinite alternate;
}
.bc-talent-node[data-state='allocated'] .bc-talent-shape { fill: var(--c); stroke: #ffffff; }
.bc-talent-node[data-kind='start'] .bc-talent-shape { fill: #e8ecf6; stroke: #ffffff; }
.bc-talent-node:hover .bc-talent-shape { stroke: #ffffff; }
@keyframes bc-node-pulse { from { stroke-opacity: 0.55; } to { stroke-opacity: 1; } }
.bc-talent-rank { fill: #0b0d12; font-size: 22px; font-weight: 800; pointer-events: none; }
.bc-talent-node[data-state='available'] .bc-talent-rank,
.bc-talent-node[data-state='reachable'] .bc-talent-rank { fill: #e8ecf6; }
.bc-talents-tooltip {
  position: fixed;
  width: 280px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(10, 12, 19, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  pointer-events: none;
  font-size: 15px;
  line-height: 1.4;
}
.bc-talents-tooltip[hidden] { display: none; }
.bc-tip-head { --c: #b6bfd6; }
.bc-tip-head[data-archetype='crit'] { --c: #ffd84d; }
.bc-tip-head[data-archetype='dot'] { --c: #ff7a2e; }
.bc-tip-head[data-archetype='chain'] { --c: #5ff4ff; }
.bc-tip-head[data-archetype='hybrid'] { --c: #c58bff; }
.bc-tip-name { font-size: 18px; font-weight: 800; color: var(--c); }
.bc-tip-kind { font-size: 12px; color: #8e98b3; letter-spacing: 0.06em; text-transform: uppercase; }
.bc-tip-body { margin-top: 8px; }
.bc-tip-mod { color: #c9d6ff; }
.bc-tip-rule { margin-top: 4px; color: #ffe9b0; }
.bc-tip-foot { margin-top: 8px; font-size: 14px; color: #a3adc6; }
.bc-tip-note { font-size: 13px; color: #8e98b3; }
.bc-tip-status[data-ok='true'] { color: #8dffb0; font-weight: 700; }
.bc-tip-status[data-ok='false'] { color: #ff8fa3; }
.bc-error {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #ff8fa3;
  font: 18px 'Segoe UI', Roboto, Arial, sans-serif;
  text-align: center;
}
`;

export function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** Creates an element with a class name and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
