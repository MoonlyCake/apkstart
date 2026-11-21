'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AdbClient } = require('../src/core/adb');
const { buildIdleCommands } = require('../src/core/container');

test('parking preserves the guest power policy in both modes', () => {
  for (const deep of [false, true]) {
    const commands = buildIdleCommands({ deep });
    assert.ok(commands.some((cmd) => cmd.startsWith('am kill-all')));
    assert.ok(!commands.some((cmd) => cmd.includes('deviceidle force-idle')), 'parking must not force Doze');
  }
});

test('foreground preparation clears legacy forced Doze without another ADB call', async () => {
  const batches = [];
  const guest = {
    forced: true,
    async shell(batch) {
      batches.push(batch);
      for (const cmd of batch.split(' ; ')) {
        if (cmd.startsWith('dumpsys deviceidle unforce ')) this.forced = false;
        if (cmd === 'wm dismiss-keyguard') assert.equal(this.forced, false, 'wake before exposing the App');
      }
    },
  };
  await AdbClient.prototype.prepareForeground.call(guest);
  assert.equal(batches.length, 1);
  assert.equal(guest.forced, false, 'foreground must recover an already parked guest');
});
