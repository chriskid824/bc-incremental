/** The web panel's stylesheet (src/ui/v3/webPanel.ts), injected once; dark like the game's UI. */

const STYLE_ID = 'v3p-style';

const CSS = `
.v3p {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #0b0d12;
  color: #e8ecf6;
  font-family: 'Segoe UI', Roboto, 'Noto Sans', 'Microsoft JhengHei', 'PingFang TC', 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.v3p button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid #3a4358;
  background: #161b27;
  padding: 8px 14px;
}
.v3p button:hover { border-color: #9fe8ff; }
.v3p button:focus-visible { outline: 2px solid #9fe8ff; outline-offset: 2px; }
.v3p-top {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 16px;
  background: #11151f;
  border-bottom: 1px solid #232a3a;
  flex-wrap: wrap;
}
.v3p-title { font-size: 22px; font-weight: 800; }
.v3p-wallet { display: flex; gap: 16px; align-items: baseline; }
.v3p-coin { display: flex; gap: 6px; align-items: baseline; }
.v3p-coin span { font-size: 13px; color: #8e98b3; font-weight: 600; }
.v3p-coin b { font-size: 20px; font-weight: 800; }
.v3p-spacer { flex: 1; }
.v3p-start { background: #ff7a2f !important; border-color: #ff7a2f !important; color: #0b0d12 !important; font-weight: 800; padding: 8px 26px !important; font-size: 17px !important; }
.v3p-start:hover { filter: brightness(1.1); }
.v3p-refund[data-armed='true'] { border-color: #ff9a6b; color: #ffcf70; }
.v3p-prestige { border-color: #c9a7ff !important; color: #e3d2ff !important; font-weight: 800; }
.v3p-prestige[hidden] { display: none; }
.v3p-dialog {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 6;
  max-width: min(460px, calc(100% - 32px));
  padding: 16px 18px;
  background: rgba(17, 21, 31, 0.98);
  border: 1px solid #c9a7ff;
  border-radius: 12px;
  line-height: 1.45;
}
.v3p-dialog[hidden], .v3p-asc[hidden] { display: none; }
.v3p-dialog-title { font-size: 18px; font-weight: 800; margin-bottom: 8px; color: #e3d2ff; }
.v3p-dialog-line { margin: 4px 0; }
.v3p-dialog-buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.v3p .v3p-dialog .v3p-confirm { background: #c9a7ff; border-color: #c9a7ff; color: #0b0d12; font-weight: 800; }
.v3p-asc {
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  z-index: 2;
  padding: 6px 12px;
  background: rgba(17, 21, 31, 0.9);
  border: 1px solid #c9a7ff;
  border-radius: 8px;
  color: #e3d2ff;
  font-weight: 700;
  pointer-events: none;
}
.v3p-slots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 16px;
  background: #0e121a;
  border-bottom: 1px solid #1c2230;
}
.v3p-slots-label { font-size: 13px; color: #8e98b3; font-weight: 700; margin-left: 10px; }
.v3p .v3p-slot {
  min-width: 132px;
  padding: 6px 12px;
  font-size: 14px;
  text-align: center;
  border-style: dashed;
  color: #8e98b3;
  background: transparent;
}
.v3p .v3p-slot[data-filled='true'] { border-style: solid; color: #e8ecf6; background: #1b2130; }
.v3p .v3p-slot[data-kind='fusion'][data-filled='true'] { border-color: #f2c46b; }
.v3p .v3p-slot[data-kind='keystone'][data-filled='true'] { border-color: #ffcf70; }
.v3p .v3p-slot[data-filled='true']:hover { border-color: #ff9a6b; text-decoration: line-through; }
.v3p .v3p-slot[data-filled='false'] { cursor: default; }
.v3p-stage { position: relative; flex: 1; min-height: 0; }
.v3p-svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.v3p-svg[data-dragging='true'] { cursor: grabbing; }
.v3p-svg text { pointer-events: none; font-family: inherit; paint-order: stroke; stroke: #0b0d12; stroke-linejoin: round; }
.v3p-svg .v3p-outer-label text, .v3p-svg .v3p-spoke text { pointer-events: auto; cursor: pointer; }
.v3p-node, .v3p-outer, .v3p-outer-label { cursor: pointer; }
.v3p-node:hover .v3p-hit { fill: rgba(159, 232, 255, 0.12); }
.v3p-outer:hover .v3p-outer-circle { fill: #1b2130; }
.v3p-outer[data-state='hidden'] { cursor: help; }
.v3p-tip, .v3p-card {
  position: absolute;
  z-index: 3;
  max-width: 360px;
  padding: 12px 14px;
  background: rgba(17, 21, 31, 0.97);
  border: 1px solid #3a4358;
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  line-height: 1.45;
}
.v3p-tip { pointer-events: none; }
.v3p-tip[hidden], .v3p-card[hidden], .v3p-pathbar[hidden] { display: none; }
.v3p-tip-name { font-size: 17px; font-weight: 800; }
.v3p-tip-kind { font-size: 13px; color: #8e98b3; margin-bottom: 6px; }
.v3p-tip-line { font-size: 14px; }
.v3p-tip-price { margin-top: 8px; font-weight: 700; color: #ffcf70; }
.v3p-tip-dps { margin-top: 6px; font-size: 13px; color: #9fe8ff; font-variant-numeric: tabular-nums; }
.v3p-tip-action { margin-top: 4px; font-size: 14px; color: #9fe8ff; }
.v3p-tip-action[data-refused='true'] { color: #ff9a6b; }
.v3p-tip-refund { margin-top: 4px; font-size: 13px; color: #8e98b3; }
.v3p-card { top: 14px; right: 14px; width: 340px; pointer-events: auto; }
.v3p-card-head { display: flex; align-items: baseline; gap: 10px; }
.v3p-card-name { font-size: 20px; font-weight: 800; }
.v3p-card-sub { font-size: 13px; color: #8e98b3; }
.v3p-card h3 { margin: 10px 0 2px; font-size: 13px; color: #8e98b3; font-weight: 700; }
.v3p-card-fusion { font-weight: 700; color: #f2c46b; }
.v3p-card-gate { margin-top: 10px; font-weight: 700; }
.v3p-card-gate[data-ready='true'] { color: #7ee08a; }
.v3p-card-buttons { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
.v3p .v3p-card-buttons button { padding: 5px 12px; font-size: 14px; }
.v3p-pathbar {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(17, 21, 31, 0.97);
  border: 1px solid #9fe8ff;
  border-radius: 10px;
  font-weight: 700;
}
.v3p .v3p-pathbar .v3p-confirm { background: #9fe8ff; border-color: #9fe8ff; color: #0b0d12; font-weight: 800; }
.v3p-zoom {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(17, 21, 31, 0.9);
  border: 1px solid #232a3a;
  border-radius: 10px;
}
.v3p .v3p-zoom button { width: 34px; height: 34px; padding: 0; font-size: 20px; line-height: 1; }
.v3p-pips { display: flex; gap: 5px; }
.v3p-pip { width: 9px; height: 9px; border-radius: 50%; background: #3a4358; }
.v3p-pip[data-on='true'] { background: #9fe8ff; }
.v3p-zoom-name { min-width: 64px; text-align: center; font-size: 13px; font-weight: 700; color: #b6bfd6; }
.v3p-hint { position: absolute; left: 14px; bottom: 14px; z-index: 1; font-size: 13px; color: #8e98b3; pointer-events: none; }
`;

export function injectPanelStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
