/**
 * Entry point of the v3 game page (game.html): the locale (the browser's, or `?lang=`), the
 * PixiJS application, the registered v3 content and the save v2 store, then the page itself
 * (game.ts). The M1 page (index.html, src/app/main.ts) is a separate entry and unchanged.
 */

import { Application } from 'pixi.js';
import { loadContent } from '../../data/web';
import { LOCALES, pickLocale, setLocale, t } from '../../i18n';
import type { Locale } from '../../i18n';
import { COLORS } from '../../render/palette';
import { injectStyle } from '../../ui/style';
import { injectGameStyle } from '../../ui/v3/gameStyle';
import { GamePage } from './game';
import { openProfileStore } from './store';

function isLocale(tag: string): tag is Locale {
  return (LOCALES as readonly string[]).includes(tag);
}

/** The browser's language, or `?lang=` in the page URL (e.g. `?lang=zh-TW`) to override it. */
function chooseLocale(): Locale {
  const requested = new URLSearchParams(window.location.search).get('lang');
  if (requested !== null && isLocale(requested)) return requested;
  return pickLocale(navigator.languages.length > 0 ? navigator.languages : [navigator.language]);
}

function showFatal(root: HTMLElement, error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement('div');
  box.className = 'bc-error';
  box.textContent = t('error.init', { message });
  root.replaceChildren(box);
}

async function main(root: HTMLElement, locale: Locale): Promise<void> {
  injectStyle(document);
  injectGameStyle(document);
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: COLORS.background,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
  });
  root.appendChild(app.canvas);
  const content = loadContent();
  const page = new GamePage({ root, app, locale, content, store: openProfileStore(content) });
  page.start();
}

const locale = chooseLocale();
setLocale(locale);
document.documentElement.lang = locale;

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app element');
main(root, locale).catch((error: unknown) => showFatal(root, error));
