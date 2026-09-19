// Install/uninstall the token-stats plugin into the Qoder user plugin registry.
//
//   node scripts/install.mjs                       install (token counts stay estimated)
//   node scripts/install.mjs --expose-token-usage  also set QODERCN_EXPOSE_TOKEN_USAGE=1
//   node scripts/install.mjs --uninstall           remove plugin, and the env var
//   node scripts/install.mjs --uninstall --keep-env
//
// Both registry files are backed up next to themselves (.bak) before writing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(source, '.qoder-plugin', 'plugin.json'), 'utf8'));

const home = process.env.QODER_HOME || path.join(os.homedir(), '.qoder-cn');
const registryFile = path.join(home, 'plugins', 'installed_plugins_v2.json');
const settingsFile = path.join(home, 'settings.json');
const key = `${manifest.name}@local`;
const installPath = path.join(home, 'plugins', 'cache', 'local', manifest.name, manifest.version);

// VCS and dependency directories must never ride along into the plugin cache.
const IGNORE = new Set(['.git', '.gitignore', 'node_modules', '.qoder']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function writeJsonWithBackup(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Qoder zeroes token counts before writing its session log unless this is set, so
// real tok/s needs it in the *user* environment before Qoder starts. A running
// process cannot change its own host env, hence it is opt-in here.
const EXPOSE_ENV = 'QODERCN_EXPOSE_TOKEN_USAGE';

// reg.exe is unusable from an MSYS shell — it rewrites `/v` into a Windows path.
// PowerShell's registry provider takes no slash flags, so it survives.
function runPowerShell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
}

function currentEnvValue() {
  const r = runPowerShell(
    `(Get-ItemProperty -Path 'HKCU:\\Environment' -Name ${EXPOSE_ENV} -ErrorAction SilentlyContinue).${EXPOSE_ENV}`,
  );
  const value = (r.stdout || '').trim();
  return r.status === 0 && value ? value : null;
}

function applyExposeEnv() {
  const existing = currentEnvValue();
  if (existing && existing !== '0') {
    return `left ${EXPOSE_ENV}=${existing} as it was (already enabled)`;
  }
  const r = runPowerShell(`setx ${EXPOSE_ENV} 1`);
  if (r.status !== 0) return `could not set ${EXPOSE_ENV}: ${(r.stderr || '').trim() || r.status}`;
  return `set ${EXPOSE_ENV}=1 in HKCU\\Environment`;
}

function revertExposeEnv() {
  const existing = currentEnvValue();
  if (!existing) return null;
  const r = runPowerShell(
    `Remove-ItemProperty -Path 'HKCU:\\Environment' -Name ${EXPOSE_ENV} -ErrorAction SilentlyContinue; setx ${EXPOSE_ENV} 0 > $null`,
  );
  if (r.status !== 0) return `could not remove ${EXPOSE_ENV}: ${(r.stderr || '').trim() || r.status}`;
  return `cleared ${EXPOSE_ENV} (was ${existing})`;
}

if (process.argv.includes('--uninstall')) {
  const registry = readJson(registryFile, { version: 2, plugins: {} });
  const envNote = process.argv.includes('--keep-env') ? null : revertExposeEnv();
  if (!registry.plugins[key]) {
    process.stdout.write(`token-stats: not registered\n`);
  } else {
    delete registry.plugins[key];
    writeJsonWithBackup(registryFile, registry);
    const settings = readJson(settingsFile, {});
    if (settings.enabledPlugins) {
      delete settings.enabledPlugins[key];
      writeJsonWithBackup(settingsFile, settings);
    }
    fs.rmSync(installPath, { recursive: true, force: true });
    process.stdout.write(
      [`token-stats: removed ${key}`, envNote ? `  ${envNote}` : '', ''].join('\n'),
    );
  }
  process.exit(0);
}

const registry = readJson(registryFile, { version: 2, plugins: {} });
registry.version = registry.version || 2;
registry.plugins = registry.plugins || {};

const previous = registry.plugins[key]?.[0];
if (previous?.installPath && path.resolve(previous.installPath) !== path.resolve(installPath)) {
  fs.rmSync(previous.installPath, { recursive: true, force: true });
}

copyDir(source, installPath);
fs.writeFileSync(path.join(installPath, 'SOURCE'), `${source}\n`, 'utf8');

const envNote = process.argv.includes('--expose-token-usage') ? applyExposeEnv() : null;

const now = new Date().toISOString();
registry.plugins[key] = [
  {
    scope: 'user',
    installPath,
    version: manifest.version,
    installedAt: previous?.installedAt || now,
    lastUpdated: now,
    userVisible: true,
  },
];
writeJsonWithBackup(registryFile, registry);

const settings = readJson(settingsFile, {});
settings.enabledPlugins = settings.enabledPlugins || {};
settings.enabledPlugins[key] = true;
writeJsonWithBackup(settingsFile, settings);

process.stdout.write(
  [
    `token-stats: installed ${key}`,
    `  path:     ${installPath}`,
    `  registry: ${registryFile}`,
    `  backups:  *.bak next to each rewritten file`,
    envNote ? `  env:      ${envNote}` : '',
    '',
    envNote
      ? 'Fully quit and reopen Qoder — the env var is read at process start.'
      : `Token counts stay estimated (Qoder zeroes them in its log). To get real`,
    envNote
      ? ''
      : `numbers, re-run with --expose-token-usage, then fully quit and reopen Qoder.`,
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
