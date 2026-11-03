/**
 * The v3 page's own styles, on top of the shared sheet (src/ui/style.ts): the select screen and
 * its cards, the start-wave picker, the pause control and the save notices.
 * Injected once.
 */

const STYLE_ID = 'bc-game-game-style';

const CSS = `
/* 傷害分佈 on the result card. */
.bc-game-damage { margin-top: 14px; }
.bc-game-damage-title { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
.bc-game-damage-heading { margin: 8px 0 4px; }
.bc-game-damage-row {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 52px;
  gap: 10px;
  padding: 3px 8px;
  font-size: 13px;
  border-radius: 4px;
  overflow: hidden;
}
.bc-game-damage-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: rgba(255, 122, 47, 0.22);
  pointer-events: none;
}
.bc-game-damage-name,
.bc-game-damage-amount,
.bc-game-damage-share {
  position: relative;
}
.bc-game-damage-name { display: block; }
.bc-game-damage-name::first-letter { text-transform: uppercase; }
.bc-game-damage-amount { color: #b8bfcc; font-variant-numeric: tabular-nums; }
.bc-game-damage-share { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
/* The talent web over the arena canvas: in flow it would sit below the full-height canvas. */
#app > .v3p {
  position: absolute;
  inset: 0;
}
.bc-game-select {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  background: radial-gradient(circle at 50% 40%, #151a28, #0b0d12 70%);
  overflow: auto;
}
.bc-game-select-header { text-align: center; }
.bc-game-select-title { font-size: 34px; font-weight: 800; }
.bc-game-select-sub { font-size: 15px; color: #8e98b3; margin-top: 4px; }
.bc-game-select-hint { font-size: 14px; color: #8e98b3; }
.bc-game-select-cards { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; padding: 0 16px; }
.bc-game-card {
  --c: #b6bfd6;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 272px;
  padding: 12px;
  border-radius: 14px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  background: rgba(20, 24, 36, 0.92);
  color: inherit;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
  transition: border-color 120ms, transform 120ms;
}
.bc-game-card-cursor { border-color: var(--c); transform: translateY(-3px); }
.bc-game-card-locked { cursor: default; }
.bc-game-card-locked .bc-game-card-name, .bc-game-card-locked .bc-game-card-intro { opacity: 0.6; }
.bc-game-card-preview {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: #0b0d12;
  align-self: center;
}
.bc-game-card-canvas { display: block; width: 100%; height: 100%; }
.bc-game-card-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 1;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--c);
  color: #0b0d12;
  font-size: 13px;
  font-weight: 800;
  text-shadow: none;
}
.bc-game-card-wip { background: rgba(14, 17, 26, 0.85); color: #ffe27a; border: 1px solid #ffe27a; }
.bc-game-card-name { font-size: 22px; font-weight: 800; color: var(--c); }
.bc-game-card-stars { display: flex; align-items: baseline; gap: 8px; }
.bc-game-card-star { color: #ffe27a; font-size: 17px; letter-spacing: 2px; }
.bc-game-card-intro { font-size: 15px; line-height: 1.35; color: #c8d0e4; min-height: 40px; }
.bc-game-card-rows { display: flex; flex-direction: column; gap: 4px; }
.bc-game-card-enemies { display: flex; align-items: center; gap: 8px; }
.bc-game-card-enemies .bc-label { min-width: 104px; font-size: 12px; }
.bc-game-card-icons { display: flex; gap: 4px; }
.bc-game-enemy-icon { width: 22px; height: 22px; fill: none; stroke: #c8d0e4; stroke-width: 1.8; }
.bc-game-card-strong .bc-game-enemy-icon { stroke: #9bf25c; }
.bc-game-card-weak .bc-game-enemy-icon { stroke: #ff8fa3; }
.bc-game-enemy-gold { stroke: #ffd24a !important; }
.bc-game-card-best { font-size: 14px; color: #8e98b3; }
.bc-game-wave { inset: auto auto 24px 24px; width: 300px; }
.bc-game-wave-box {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(20, 24, 36, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: auto;
}
.bc-game-wave-hint { font-size: 13px; color: #8e98b3; margin-top: 6px; }
.bc-game-pause { inset: auto auto 20px 24px; display: flex; gap: 8px; }
.bc-game-paused {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 40px;
  font-weight: 800;
  letter-spacing: 0.1em;
}
.bc-game-notices {
  inset: 16px 16px auto auto;
  width: min(420px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 20;
}
.bc-game-notice {
  pointer-events: auto;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(20, 24, 36, 0.97);
  border: 1px solid #ffe27a;
  font-size: 15px;
  line-height: 1.35;
}
.bc-game-notice-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
`;

export function injectGameStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}
