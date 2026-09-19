// Install/uninstall the token-stats plugin into the Qoder user plugin registry.
//
//   node scripts/install.mjs            install
//   node scripts/install.mjs --uninstall
//
// Both registry files are backed up next to themselves (.bak) before writing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(source, '.qoder-plugin', 'plugin.json'), 'utf8'));

const home = process.env.QODER_HOME || path.join(os.homedir(), '.qoder-cn');
const registryFile = path.join(home, 'plugins', 'installed_plugins_v2.json');
const settingsFile = path.join(home, 'settings.json');
const key = `${manifest.name}@local`;
const installPath = path.join(home, 'plugins', 'cache', 'local', manifest.name, manifest.version);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
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

if (process.argv.includes('--uninstall')) {
  const registry = readJson(registryFile, { version: 2, plugins: {} });
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
    process.stdout.write(`token-stats: removed ${key}\n`);
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
    '',
    'Restart Qoder so the Stop hook is picked up.',
    '',
  ].join('\n'),
);
