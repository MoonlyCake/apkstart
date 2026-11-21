'use strict';

// Real Electron/Windows shell-link fixture; no Android or live shortcut is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, shell } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-shortcut-brand-'));
const profile = path.join(root, 'electron');
fs.mkdirSync(profile);
app.setPath('userData', profile);
process.env.APPDATA = path.join(root, 'roaming');

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  const { Installer } = require('../src/core/installer');
  const { appAumid } = require('../src/core/branding');
  const { migrateAppShortcutBrand } = require('../src/core/shortcut');
  const store = require('../src/core/store');
  const pkg = 'com.example.song';
  const old = `RoutineMiku.ApkStart.${pkg}`;
  const next = `MoonlyCake.ApkStart.${pkg}`;
  const desktopDir = path.join(root, 'desktop');
  const startMenuDir = path.join(root, 'start');
  const installer = new Installer({}, { desktopDir, startMenuDir, launcherTarget: process.execPath, cwd: root });
  const record = { package: pkg, label: '全民 K 歌' };
  const [desktop, startMenu] = installer.shortcutPaths(record);
  const moved = path.join(root, 'redirected', '我移动的入口.lnk');
  const pinned = path.join(root, 'User Pinned', 'TaskBar', '旧固定项.lnk');
  const foreign = path.join(root, '另一个包.lnk');
  const icon = path.join(process.env.SystemRoot, 'System32', 'shell32.dll');
  const makeLink = (lnk, args) => {
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    assert(shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath, args, cwd: root, icon, iconIndex: 3,
      description: 'existing link', appUserModelId: old,
    }));
    return shell.readShortcutLink(lnk);
  };
  const before = [desktop, startMenu, moved].map((lnk) => makeLink(lnk, `--launch "${pkg}"`));
  assert(before.every((link) => link.appUserModelId === old));
  const pinnedBefore = makeLink(pinned, `--launch ${pkg}`);
  const foreignBefore = makeLink(foreign, '--launch com.other.app');
  store.saveApps([{ ...record, shortcutPath: moved, startMenuPath: startMenu }]);
  assert.deepEqual(await installer.ensureShortcuts(), [], 'migration is not a missing shortcut repair');
  for (const [i, link] of [desktop, startMenu, moved].entries()) {
    assert.deepEqual(shell.readShortcutLink(link), { ...before[i], appUserModelId: next });
    assert.equal(migrateAppShortcutBrand(link, pkg), false, 'already migrated links are not rewritten');
  }
  assert.equal(migrateAppShortcutBrand(pinned, pkg), false);
  assert.equal(migrateAppShortcutBrand(foreign, pkg), false);
  assert.deepEqual(shell.readShortcutLink(pinned), pinnedBefore);
  assert.deepEqual(shell.readShortcutLink(foreign), foreignBefore);
  const created = installer.createShortcut({ package: 'com.example.newapp', label: 'New app' });
  assert.equal(shell.readShortcutLink(created).appUserModelId, appAumid('com.example.newapp'));
  console.log(`SHORTCUT_BRAND_OK ${old} → ${next}; desktop, start menu, redirected; unrelated / pinned untouched`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
