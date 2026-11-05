/**
 * Packages a Steam release of the game for Windows x64 (`npm run package:steam -- --release demo`):
 *
 * 1. Builds the page with VITE_FLAVOR=<release> (`vite build --mode steam`, dist-steam/) and the
 *    Electron shell with BC_RELEASE=<release> (dist-electron/, electron/release.ts).
 * 2. Fetches Electron's win32-x64 zip for the installed electron version (cached in
 *    ~/.cache/bc-incremental/electron/) and checks it against Electron's SHASUMS256.txt.
 * 3. Lays the build out under out/steam/<release>/win64/: Electron's files, electron.exe renamed
 *    to the launch option's name ("Archefuse Demo.exe" or "Archefuse.exe"), and resources/app/
 *    holding package.json, dist-steam/, dist-electron/ and steamworks.js with its win64 natives.
 * 4. Zips that folder to out/steam/archefuse-<release>-win64-<build>.zip, the file Steamworks'
 *    web upload ("Upload via web" under SteamPipe > Builds) or a SteamPipe content root takes.
 *
 * Runs on Linux (unzip, zip, curl) or on Windows 10+ (tar, curl). The exe keeps Electron's icon:
 * setting it needs rcedit, which this tool leaves out.
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRelease, releaseSetup } from '../../electron/release';
import type { ReleaseSetup } from '../../electron/release';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function run(command: string, env: Record<string, string>): void {
  console.log(`> ${command}`);
  execSync(command, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** Whether `tool` runs (`-v` prints the version for unzip and zip). */
function has(tool: string): boolean {
  try {
    execFileSync(tool, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Electron's win32-x64 zip for `version`, downloaded once and checked against SHASUMS256.txt. */
function electronZip(version: string): string {
  const name = `electron-v${version}-win32-x64.zip`;
  const dir = join(homedir(), '.cache', 'bc-incremental', 'electron');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, name);
  const sums = join(dir, `SHASUMS256-v${version}.txt`);
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  if (!existsSync(sums)) execFileSync('curl', ['-fsSL', '-o', sums, `${base}/SHASUMS256.txt`]);
  const line = readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.trim().endsWith(`*${name}`) || l.trim().endsWith(` ${name}`));
  if (line === undefined) throw new Error(`${name} is not in Electron's SHASUMS256.txt`);
  const want = line.trim().split(/\s+/)[0];
  if (!existsSync(zip) || sha256(zip) !== want) {
    console.log(`> downloading ${name}`);
    execFileSync('curl', ['-fL', '--retry', '3', '-o', zip, `${base}/${name}`], {
      stdio: 'inherit',
    });
  }
  if (sha256(zip) !== want) throw new Error(`${name} does not match SHASUMS256.txt`);
  return zip;
}

function unzipTo(zip: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (has('unzip')) execFileSync('unzip', ['-q', zip, '-d', dir]);
  else execFileSync('tar', ['-xf', zip, '-C', dir]);
}

function zipDir(dir: string, out: string): void {
  rmSync(out, { force: true });
  if (has('zip')) execFileSync('zip', ['-qr', '-X', out, '.'], { cwd: dir });
  else execFileSync('tar', ['-a', '-cf', out, '.'], { cwd: dir });
}

function removeMaps(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeMaps(path);
    else if (entry.name.endsWith('.map')) rmSync(path);
  }
}

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return 'dev';
  }
}

function lay(setup: ReleaseSetup, zip: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  unzipTo(zip, outDir);
  renameSync(join(outDir, 'electron.exe'), join(outDir, `${setup.title}.exe`));
  rmSync(join(outDir, 'resources', 'default_app.asar'), { force: true });

  const app = join(outDir, 'resources', 'app');
  const pkg = readJson<{ version: string }>(join(ROOT, 'package.json'));
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify(
      {
        name: 'archefuse',
        productName: setup.title,
        version: pkg.version,
        private: true,
        main: 'dist-electron/main.cjs',
      },
      null,
      2,
    )}\n`,
  );
  cpSync(join(ROOT, 'dist-steam'), join(app, 'dist-steam'), { recursive: true });
  cpSync(join(ROOT, 'dist-electron'), join(app, 'dist-electron'), { recursive: true });
  removeMaps(app);

  const steamworks = join(ROOT, 'node_modules', 'steamworks.js');
  const target = join(app, 'node_modules', 'steamworks.js');
  for (const file of ['package.json', 'index.js', 'LICENSE']) {
    cpSync(join(steamworks, file), join(target, file));
  }
  for (const file of ['steam_api64.dll', 'steamworksjs.win32-x64-msvc.node']) {
    cpSync(join(steamworks, 'dist', 'win64', file), join(target, 'dist', 'win64', file));
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--release');
  const release = parseRelease(at >= 0 ? argv[at + 1] : 'demo');
  if (release === 'dev') throw new Error('--release must be demo or full');
  const setup = releaseSetup(release);

  run('npx vite build --mode steam', { VITE_FLAVOR: release });
  run('npx vite build --config vite.electron.config.ts --mode main', { BC_RELEASE: release });
  run('npx vite build --config vite.electron.config.ts --mode preload', { BC_RELEASE: release });
  const main = readFileSync(join(ROOT, 'dist-electron', 'main.cjs'), 'utf8');
  if (!main.includes(`"${release}"`)) throw new Error(`main.cjs was not built for ${release}`);

  const electron = readJson<{ version: string }>(
    join(ROOT, 'node_modules', 'electron', 'package.json'),
  ).version;
  const out = join(ROOT, 'out', 'steam');
  const dir = join(out, release, 'win64');
  lay(setup, electronZip(electron), dir);

  const zip = join(out, `archefuse-${release}-win64-${buildId()}.zip`);
  zipDir(dir, zip);
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    [
      `${setup.title}: App ID ${setup.appId}, page ${setup.page}, Electron ${electron}`,
      `folder ${relative(ROOT, dir)} (${mb(sizeOf(dir))}), launch "${setup.title}.exe"`,
      `zip    ${relative(ROOT, zip)} (${mb(statSync(zip).size)})`,
    ].join('\n'),
  );
}

main();
