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
.bc-result-talents { margin-top: 16px; font-size: 16px; line-height: 1.45; color: #d7ddeb; }
.bc-result-talents .bc-label { display: block; margin-bottom: 4px; }
.bc-result-next { margin-top: 18px; font-size: 15px; color: #8e98b3; text-align: center; }
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
