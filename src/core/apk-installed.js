'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { parsePmPaths } = require('./adb');
const { validPackageName } = require('./pkgname');

async function matchesInstalledApk(client, pkg, file) {
  if (!validPackageName(pkg)) return false;
  try {
    const paths = parsePmPaths(await client.shell(`pm path --user 0 ${pkg}`, { timeout: 6000 }));
    if (paths.length !== 1 || !/^\/[^\r\n\0]*\.apk$/.test(paths[0])) return false;
    const apk = paths[0];
    // Hash the actual guest file, not the host backup or package/version metadata.
    const quoted = `'${apk.replace(/'/g, "'\\''")}'`;
    const output = (await client.shell(`sha256sum ${quoted}`, { timeout: 15000 })).trim();
    const digest = /^([0-9a-f]{64})[ \t]+(.+)$/i.exec(output);
    if (!digest || digest[2] !== apk) return false;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex') === digest[1].toLowerCase();
  } catch (_) {
    // A missing/unreadable APK or hash command never bypasses Android's installer.
    return false;
  }
}

module.exports = { matchesInstalledApk };
