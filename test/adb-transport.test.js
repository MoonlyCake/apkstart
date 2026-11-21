'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { AdbClient, adbEnvironment, resolveAdbPath, resolveAdbPort } = require('../src/core/adb');
const { EmulatorEngine } = require('../src/core/emulator');
const { Runtime } = require('../src/core/engine');
const { Provisioner } = require('../src/core/provision');
const { createRuntimeHandlers } = require('../src/ipc/handlers/runtime');

test('ADB resolution gives the managed copy precedence and has an explicit PATH fallback', () => {
  const appRoot = path.resolve('fixture-app');
  const bundled = path.resolve('fixture-runtime', 'platform-tools', 'adb.exe');
  const configured = path.resolve('fixture-sdk', 'custom-adb.exe');
  const tools = path.join(appRoot, 'tools', 'platform-tools', 'adb.exe');
  const engine = path.join(appRoot, 'engine', 'platform-tools', 'adb.exe');
  const fixtures = new Set([bundled, configured, tools, engine]);
  const options = { bundled, configured, appRoot, exists: (file) => fixtures.has(file) };
  for (const selected of [bundled, configured, tools, engine]) {
    assert.equal(resolveAdbPath(options), selected);
    fixtures.delete(selected);
  }
  assert.equal(resolveAdbPath(options), 'adb');
  assert.equal(resolveAdbPath({ ...options, allowPath: false }), '');
  assert.equal(resolveAdbPort('5123'), 5123);
  assert.equal(resolveAdbPort('1.5'), 5044);
  assert.equal(resolveAdbPort('65536'), 5044);
  assert.equal(adbEnvironment(undefined, { APKSTART_ADB_PORT: '5123' }).ANDROID_ADB_SERVER_PORT, '5123');
  const clean = adbEnvironment(5123, { Adb_Server_Socket: 'inherited', ANDROID_ADB_SERVER_ADDRESS: 'inherited' });
  assert.equal(clean.ANDROID_ADB_SERVER_PORT, '5123');
  assert.equal(clean.Adb_Server_Socket, undefined);
  assert.equal(clean.ANDROID_ADB_SERVER_ADDRESS, undefined);
});

test('provision version, daemon bootstrap, console and guest commands share the same executable and port', async () => {
  const adbPath = path.resolve('fixture-runtime', 'platform-tools', 'adb.exe');
  const port = 5119;
  const transport = [];
  const processCalls = [];
  const p = Object.create(Provisioner.prototype);
  p.adbPath = () => adbPath;
  p.adbClient = ({ adbPath: requested = p.adbPath(), serial, port: currentPort = port }) => {
    return new AdbClient({
      adbPath: requested, serial, port: currentPort,
      executeFile(file, args, options, done) {
        transport.push({ file, args, options });
        done(null, args[0] === 'version' ? 'Android Debug Bridge version 1.0.41' : ' OK ', '');
      },
      startProcess(file, args, options) {
        processCalls.push({ file, args, options });
        return Object.assign(new EventEmitter(), {
          exitCode: null, stdin: new EventEmitter(), stderr: new EventEmitter(),
          stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
        });
      },
    });
  };
  const runtime = Object.create(Runtime.prototype);
  runtime.provisioner = p;
  runtime.emulator = new EmulatorEngine('fixture', { provisioner: p });
  runtime.emulator.adbPort = port;
  assert.deepEqual(await p.adbVersion(), { ok: true, path: adbPath, version: '1.0.41' });
  assert.deepEqual(await p.adbVersion(), { ok: true, path: adbPath, version: '1.0.41' });
  await runtime.emulator._startAdbServer(port);
  const guest = runtime.client('127.0.0.1:5557');
  assert.equal(await guest.shell('cat /sdcard/ui.xml', { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }), 'OK');
  guest._inputSession();
  await runtime.adbClient('emulator-5556').exec(['emu', 'avd', 'name']);
  assert.deepEqual(transport.map((item) => item.args), [
    ['version'], ['start-server'], ['-s', '127.0.0.1:5557', 'shell', 'cat /sdcard/ui.xml'],
    ['-s', 'emulator-5556', 'emu', 'avd', 'name'],
  ]);
  assert.deepEqual(processCalls[0].args, ['-s', '127.0.0.1:5557', 'shell']);
  for (const call of [...transport, ...processCalls]) {
    assert.equal(call.file, adbPath);
    assert.equal(call.options.env.ANDROID_ADB_SERVER_PORT, String(port));
    assert.equal(call.options.env.ADB_SERVER_SOCKET, undefined);
  }
  assert.equal(transport[2].options.maxBuffer, 8 * 1024 * 1024);
  assert.equal(transport[2].options.timeout, 10000);
  assert.equal(transport[1].options.timeout, 12000);
});

const { WIFI_STATUS, SNAPSHOT_COMMAND, STOCK_WIFI_CONNECT } = require('../src/core/emulator-network');
const CONNECTED_DUMP = 'Active default network: 100\n  NetworkAgentInfo{network{100} '
  + 'lp{{InterfaceName: wlan0 LinkAddresses: [ 10.0.2.16/24 ] Routes: [ 0.0.0.0/0 -> 10.0.2.2 wlan0 mtu 0 ]}} '
  + 'nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED ]}}';
const WIFI_CONNECTED = 'Wifi is enabled\nWifi is connected to "AndroidWifi"\n__APKSTART_VALIDATION_MODE__=null';
const WIFI_DISCONNECTED = 'Wifi is enabled\nWifi is not connected\n__APKSTART_VALIDATION_MODE__=null';

function networkFixture() {
  const runtime = Object.create(Runtime.prototype);
  const emulator = Object.create(EmulatorEngine.prototype);
  runtime.emulator = emulator;
  runtime.emuSerial = '127.0.0.1:5557';
  const selected = [];
  const writes = [];
  let owned = true;
  let proofs = [];
  let afterShell = () => {};
  runtime.ownedEmulator = async () => owned ? {
    port: 5556, serial: 'emulator-5556',
    revalidate: async ({ adbPort }) => { proofs.push(adbPort); return owned; },
  } : null;
  runtime.client = (serial) => {
    selected.push(serial);
    return {
      serial,
      async shell(cmd) {
        writes.push({ serial, cmd });
        afterShell();
        return cmd === WIFI_STATUS ? WIFI_CONNECTED : CONNECTED_DUMP;
      },
    };
  };
  return { runtime, selected, writes, proofs, loseOwnership() { owned = false; },
    afterShell(callback) { afterShell = callback; } };
}

test('network IPC delegates to Runtime and follows the verified TCP alias, not the emulator default serial', async () => {
  const { runtime, selected, writes, proofs } = networkFixture();
  const handlers = createRuntimeHandlers({ live: { runtime }, send: () => {} });
  const response = await handlers['runtime:checkNetwork']();
  assert.deepEqual(response, { ok: true, network: {
    ok: true, reason: '', gateway: '10.0.2.2', ip: '10.0.2.16', wifiConnected: true,
    reachable: true, validated: true, networkId: 100,
  } });
  assert.deepEqual(selected, ['127.0.0.1:5557']);
  assert.equal(writes.length, 2);
  assert.ok(proofs.length >= 2 && proofs.every((proof) => proof === true));
});

test('network facet rejects unknown owners and discards responses from a retired guest', async () => {
  const old = networkFixture();
  old.loseOwnership();
  assert.deepEqual(await old.runtime.checkNetwork(), { ok: false, reason: 'device-offline' });
  assert.equal(await old.runtime.repairWifi(), false);
  assert.deepEqual(old.writes, []);

  const stale = networkFixture();
  stale.afterShell(() => stale.runtime._retireGuest());
  assert.deepEqual(await stale.runtime.checkNetwork(), { ok: false, reason: 'guest-changed' });
  assert.deepEqual(stale.writes, [{ serial: '127.0.0.1:5557', cmd: WIFI_STATUS }]); // no command reaches the successor
});

test('tracked QEMU uses its own forwarded port and does not fall back to a foreign emulator', async () => {
  const { runtime, selected } = networkFixture();
  const owns = new Set([4200]);
  runtime.vmProc = { pid: 4200, killed: false };
  runtime.loopbackOwners = async () => new Map([[5555, owns]]);
  assert.equal((await runtime.checkNetwork()).ok, true);
  assert.deepEqual(selected, ['127.0.0.1:5555']);
  owns.add(4201);
  assert.deepEqual(await runtime.checkNetwork(), { ok: false, reason: 'device-offline' });
  assert.deepEqual(selected, ['127.0.0.1:5555']);
});

test('Wi-Fi repair uses the same scoped client for stock Wi-Fi and drops writes after ownership changes', async () => {
  const emulator = Object.create(EmulatorEngine.prototype);
  let owns = true;
  let connected = false;
  let revokeDuringScan = false;
  const calls = [];
  const client = {
    shell: async (command, options) => {
      calls.push([command, options]);
      if (command === WIFI_STATUS) return connected ? WIFI_CONNECTED : WIFI_DISCONNECTED;
      if (command === SNAPSHOT_COMMAND) return connected ? CONNECTED_DUMP : 'Active default network: none';
      if (command === 'cmd wifi list-scan-results') {
        if (revokeDuringScan) owns = false;
        return '02:15:b2:00:01:00 2447 -30 1.538 AndroidWifi [ESS]';
      }
      if (command === STOCK_WIFI_CONNECT) {
        connected = true;
        return 'Connection initiated';
      }
      throw new Error('unexpected guest shell command: ' + command);
    },
  };
  assert.equal(await emulator.repairWifi(client, { pause: async () => {}, canMutate: async () => owns }), true);
  assert.ok(calls.some(([cmd]) => cmd === STOCK_WIFI_CONNECT));
  calls.length = 0;
  connected = false;
  revokeDuringScan = true;
  assert.equal(await emulator.repairWifi(client, {
    pause: async () => {},
    canMutate: async () => owns,
  }), false);
  assert.deepEqual(calls.map(([cmd]) => cmd), [WIFI_STATUS, SNAPSHOT_COMMAND, 'cmd wifi list-scan-results']);
});
