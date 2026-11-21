'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeUpdatePayload(dir, version, mode = 'zip') {
  const app = path.join(dir, 'resources', 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version, main: 'src/main.js' }));
  fs.writeFileSync(path.join(app, 'src', 'main.js'), 'fixture entry point');
  if (mode === 'zip') {
    for (const name of ['ApkStart.exe', 'resources.pak', 'icudtl.dat']) {
      fs.writeFileSync(path.join(dir, name), name === 'ApkStart.exe' ? 'fixture' : name);
    }
  }
}

module.exports = { writeUpdatePayload };
