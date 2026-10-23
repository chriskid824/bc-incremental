/**
 * The shell's own command-line arguments (docs/v3 C9 design §1.5; C10 ruling L1), found anywhere
 * in process.argv among Electron's and Chromium's, which are left alone:
 *
 * - `--steam-check`: the check mode (design §2.2's panel), reported as ShellInfo.checkMode.
 * - `--bc-user-data-dir=<absolute>`: userData in another folder (the smoke's temporary one).
 * - `--bc-overlay-switches`: the Steam overlay's Chromium switches without Steam (the smoke).
 * - `--bc-replay=<spec>`: the page opens with the query `?replay=<spec>` (C10's replay route).
 *
 * Only the replay spec reaches the page, and only when it is letters, digits, `:` and `.`, so no
 * launch option can turn on another query flag of the page. A value that is not taken, and an
 * argument of the shell's that is not one of these, is ignored with one line for the terminal.
 * When an argument comes twice, the last value taken wins, as Chromium's switches do.
 */

import { posix, win32 } from 'node:path';

export const REPLAY_SPEC = /^[A-Za-z0-9:.]+$/;

export interface ShellArgs {
  readonly checkMode: boolean;
  readonly userDataDir: string | null;
  readonly overlaySwitches: boolean;
  readonly replay: string | null;
  /** One line for each argument ignored, for the terminal. */
  readonly ignored: readonly string[];
}

const CHECK = '--steam-check';
const USER_DATA_DIR = '--bc-user-data-dir';
const OVERLAY_SWITCHES = '--bc-overlay-switches';
const REPLAY = '--bc-replay';

/** The shell's arguments in `argv`; the paths are checked by `platform`'s rules. */
export function parseShellArgs(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ShellArgs {
  const paths = platform === 'win32' ? win32 : posix;
  let checkMode = false;
  let overlaySwitches = false;
  let userDataDir: string | null = null;
  let replay: string | null = null;
  const ignored: string[] = [];
  for (const arg of argv) {
    const [name, value] = split(arg);
    if (arg === CHECK) {
      checkMode = true;
    } else if (arg === OVERLAY_SWITCHES) {
      overlaySwitches = true;
    } else if (name === USER_DATA_DIR) {
      if (paths.isAbsolute(value)) userDataDir = value;
      else ignored.push(`Ignoring ${shown(name, value)}: the folder must be an absolute path.`);
    } else if (name === REPLAY) {
      if (REPLAY_SPEC.test(value)) replay = value;
      else
        ignored.push(`Ignoring ${shown(name, value)}: a replay is letters, digits, ':' and '.'.`);
    } else if (name === CHECK || name.startsWith('--bc-')) {
      ignored.push(`Ignoring ${shown(name, value)}: not an argument of this shell.`);
    }
  }
  return { checkMode, userDataDir, overlaySwitches, replay, ignored };
}

/** `--name=value` as its name and value; an argument without `=` has the value ''. */
function split(arg: string): [string, string] {
  const at = arg.indexOf('=');
  return at < 0 ? [arg, ''] : [arg.slice(0, at), arg.slice(at + 1)];
}

/** The argument for a terminal line: the value quoted, so that a line break in it stays one line. */
function shown(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)}`;
}
