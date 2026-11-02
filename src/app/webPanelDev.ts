/**
 * Dev-only page of the v3 web panel (src/ui/v3/webPanel.ts), served by `npm run dev` at
 * /webpanel.html and never built: a character's web with an in-memory progress and a generous
 * wallet. Every change is logged to the console and kept in `window.__panel` for scripts.
 *
 * URL parameters: `character` (default fire), `scope` (full, demoA, demoB), `locale` (en, zh-TW),
 * `wave` (the best wave, default 15: the recommended outers and revealAt15's), `shards`, `cores`,
 * `default=<n>` (the first n purchases of the default order owned), `singularity` (3 fusion slots).
 *
 * The text here is for developers, not players, so it is plain English rather than i18n keys.
 */

import { num } from '../core/num';
import type { CharacterId } from '../data/sources';
import { assembleWeb, loadContent, SCOPES } from '../data/web';
import type { WebScope } from '../data/web';
import type { Locale } from '../i18n';
import { defaultProgress, emptyProgress } from '../meta/web';
import type { AccountProgress, CharacterProgress } from '../meta/web';
import { WebPanel } from '../ui/v3/webPanel';

const params = new URLSearchParams(window.location.search);
const numberParam = (name: string, fallback: number): number => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) ? value : fallback;
};

const character = (params.get('character') ?? 'fire') as CharacterId;
const scope: WebScope =
  SCOPES.find((candidate) => candidate.name === params.get('scope')) ?? (SCOPES[0] as WebScope);
const locale: Locale = params.get('locale') === 'zh-TW' ? 'zh-TW' : 'en';
const account: AccountProgress = { singularityBeaten: params.has('singularity') };
const web = assembleWeb(loadContent(), character, scope);

const owned = params.has('default')
  ? defaultProgress(web, account, numberParam('default', 0))
  : emptyProgress(character);
const initial: CharacterProgress = {
  ...owned,
  wallet: {
    shards: num(numberParam('shards', 1e15)),
    cores: numberParam('cores', 40),
    resonance: 0,
  },
  spent: owned.spent,
  bestWave: numberParam('wave', 15),
  cycleBest: numberParam('wave', 15),
};

const host = document.getElementById('panel') as HTMLElement;
const state = { progress: initial, starts: 0, backs: 0 };
const panel = new WebPanel(host, {
  web,
  account,
  locale,
  initial,
  onChange: (progress) => {
    state.progress = progress;
    console.info('web panel: progress changed', progress);
  },
  onStartRun: () => {
    state.starts += 1;
    console.info('web panel: start run');
  },
  onBack: () => {
    state.backs += 1;
    console.info('web panel: back');
  },
});
Object.assign(window, { __panel: { panel, state } });
document.documentElement.dataset.panelReady = 'true';
