'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { author: MAINTAINER, productName } = require('../../package.json');

// Keep this ID stable across future versions: Windows uses it to group pins and notifications.
const APP_AUMID = 'MoonlyCake.ApkStart';
const WINDOWS_DISPLAY_NAME = `${productName} · ${MAINTAINER}`;
const appAumid = (pkg) => `${APP_AUMID}.${pkg}`.slice(0, 128);

function registerManagerShortcut({ shell, programs, target, icon, toastActivatorClsid }) {
  const dir = path.join(programs, 'ApkStart');
  const link = path.join(dir, `${WINDOWS_DISPLAY_NAME}.lnk`);
  const details = { target, cwd: path.dirname(target), icon, iconIndex: 0, description: WINDOWS_DISPLAY_NAME,
    appUserModelId: APP_AUMID };
  if (toastActivatorClsid) details.toastActivatorClsid = toastActivatorClsid;
  const exists = fs.existsSync(link);
  if (exists) {
    const old = shell.readShortcutLink(link);
    // Never repoint an unrelated shortcut, even if its filename matches ours.
    if (old.appUserModelId !== APP_AUMID) throw new Error('The Windows Start Menu path is already in use');
    if (Object.entries(details).every(([key, value]) => old[key] === value)) return link;
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!shell.writeShortcutLink(link, exists ? 'update' : 'create', details)
      || shell.readShortcutLink(link).appUserModelId !== APP_AUMID) {
    throw new Error('Could not register the Windows notification sender');
  }
  return link;
}

function showAsManager(publish, activeAumid, setAumid) {
  // Electron can cache its Windows sender in isSupported() or the constructor, before show().
  if (activeAumid === APP_AUMID) return publish();
  setAumid(APP_AUMID);
  try { return publish(); } finally { setAumid(activeAumid); }
}

module.exports = { APP_AUMID, MAINTAINER, WINDOWS_DISPLAY_NAME, appAumid, registerManagerShortcut, showAsManager };
