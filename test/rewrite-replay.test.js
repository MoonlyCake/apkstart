'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { Runtime } = require('../src/core/engine');
const { EmulatorEngine } = require('../src/core/emulator');
const { findOwnedEmulator } = require('../src/core/runtime-ownership');
const { WinAgent } = require('../src/core/agent');
const { runLaunchPolicy } = require('../src/application/launch-policy');
const { createWindowAttachment } = require('../src/application/window-attachment');
const { recordSyntheticTrace, replaySyntheticTrace } = require('./harness/synthetic-trace');
const lifecycleFixture = require('./harness/fixtures/synthetic-lifecycle.json');
const foreignFixture = require('./harness/fixtures/synthetic-foreign-runtime.json');

const SERIAL = 'emulator-5556';
const PKG = 'org.apkstart.fixture';
const RECT = { x: 0.4, y: -2.25, w: 640.2, h: 722.75, clipTop: 14.5 };

function fixtureRuntime(trace) {
  const runtime = Object.create(Runtime.prototype);
  Object.defineProperty(runtime, 'settings', { value: { engine: {}, runtime: {} } });
  const emu = Object.create(EmulatorEngine.prototype);
  runtime.emulator = emu;
  runtime.adbPath = () => 'synthetic-adb';
  runtime.provisioner = {
    materializeImages: async () => trace.call('provision.materialize'),
    checkEnv: async () => trace.call('provision.environment'),
  };
  let running = false;
  emu.running = () => running;
  emu.start = async ({ headless, probe }) => {
    // Keep the real boot/readiness code; substitute a deterministic emulator process.
    const result = trace.call('emulator.start', { headless });
    running = true;
    assert.equal(await probe({ serial: result.serial, port: result.port }), 'ok');
    return result;
  };
  const fakeClient = (serial) => ({
    serial, adbPath: runtime.adbPath(),
    shell: async (command, options) => trace.call('adb.shell', serial, command, options),
    exec: async (argv, options) => {
      const reply = trace.call('adb.exec', serial, argv, options);
      if (argv[0] === 'emu' && argv[1] === 'kill') running = false;
      return reply;
    },
  });
  runtime.client = fakeClient;
  runtime._probeClient = fakeClient(SERIAL);
  emu.setPriority = async (level, identity) => trace.call('emulator.priority', level, identity.pid);
  emu.scheduleSnapshotSave = ({ delay }) => trace.call('snapshot.schedule', delay);
  runtime.prepare = async (client) => trace.call('guest.prepare', client.serial);
  emu._avdOwner = () => trace.call('avd.owner');
  emu._adbGuestHealthy = async (_client, identity) => trace.call('guest.healthy', identity.serial);
  emu._consoleAlive = async (port) => trace.call('console.alive', port);
  runtime.inspectEmulatorOwnership = () => findOwnedEmulator({
    readOwner: emu._avdOwner,
    readListeners: async () => new Map(trace.call('loopback.listeners').map(([port, pids]) => [port, new Set(pids)])),
    consoleClient: fakeClient,
  });
  return runtime;
}

async function showApp({ trace, agent, client, host }) {
  const attachment = createWindowAttachment(async () => (await agent.embed(host, RECT)).ok);
  let elapsed = 0;
  await runLaunchPolicy({
    start: async () => trace.call('app.start', client.serial, PKG),
    probe: async ({ timeout }) => trace.call('app.pids', client.serial, PKG, timeout),
    onAppUp: () => attachment.startEarly(),
  }, {
    observeMs: 20, stableMs: 1, pollMs: 1, probeMs: 10,
    now: () => elapsed,
    sleep: async (delta) => { elapsed += delta; },
  });
  assert.equal(await attachment.finish(), true);
  assert.equal((await agent.fit(RECT)).ok, true);
}

test('synthetic cold launch, failed early attach, close/reopen, and owned shutdown replay without installed tools', async (t) => {
  const trace = replaySyntheticTrace(lifecycleFixture);
  t.after(() => trace.assertComplete());
  const runtime = fixtureRuntime(trace);
  const agent = new WinAgent();
  agent.call = async (request, timeout) => trace.call('window.rpc', request, timeout);

  const initial = await runtime.ensure();
  assert.equal(initial.ok, true, initial.error);
  assert.equal(initial.client.serial, SERIAL);
  await showApp({ trace, agent, client: initial.client, host: 450 });
  assert.equal((await agent.detach()).ok, true);

  const reopened = await runtime.ensure();
  assert.equal(reopened.reused, true);
  await showApp({ trace, agent, client: reopened.client, host: 451 });
  assert.equal((await agent.detach()).ok, true);
  assert.equal(await runtime.stop(), true);
});

test('synthetic foreign console cannot receive guest preparation, window calls, or a stop command', async (t) => {
  const trace = replaySyntheticTrace(foreignFixture);
  t.after(() => trace.assertComplete());
  const runtime = fixtureRuntime(trace);
  assert.equal((await runtime.ensure()).ok, false);
  assert.equal(await runtime.stop(), false);
});

test('synthetic recorder preserves round-trip results and typed errors without I/O', () => {
  const response = { lines: ['synthetic'] };
  const record = recordSyntheticTrace((operation) => {
    if (operation === 'unavailable') throw Object.assign(new Error('not ready'), { code: 'OFFLINE' });
    return response;
  });
  assert.equal(record.call('probe', 1), response);
  assert.throws(() => record.call('unavailable'), { code: 'OFFLINE' });
  response.lines.push('caller mutation');

  const replay = replaySyntheticTrace(record.fixture());
  assert.deepEqual(replay.call('probe', 1), { lines: ['synthetic'] });
  assert.throws(() => replay.call('unavailable'), { code: 'OFFLINE', message: 'not ready' });
  replay.assertComplete();
});

test('replay detects missing, changed, and extra requests even after a caller catches the error', () => {
  const record = recordSyntheticTrace(() => true);
  record.call('probe', { ready: true });
  const fixture = record.fixture();
  const skipped = replaySyntheticTrace(fixture);
  assert.throws(() => skipped.assertComplete(), /unconsumed/);

  const changed = replaySyntheticTrace(fixture);
  assert.throws(() => changed.call('probe', { ready: false }), /step 1/);
  assert.throws(() => changed.assertComplete(), /step 1/);

  const extra = replaySyntheticTrace(fixture);
  extra.call('probe', { ready: true });
  assert.throws(() => extra.call('kill'), /step 2/);
});


function fakeAgentChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}

function fakeAgentSocket() {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.setNoDelay = () => {};
  socket.destroy = () => socket.emit('close');
  socket.writes = [];
  socket.write = (message) => socket.writes.push(JSON.parse(message));
  return socket;
}

test('window agent rejects a failed TCP startup and ignores old child/socket events after retry', async (t) => {
  const agent = new WinAgent();
  t.after(() => agent.dispose());
  const children = [fakeAgentChild(), fakeAgentChild()];
  const [oldSocket, activeSocket] = [fakeAgentSocket(), fakeAgentSocket()];
  const ports = [];
  let spawns = 0;
  let exits = 0;
  Object.defineProperty(agent, 'available', { value: true });
  agent._spawnProcess = () => children[spawns++];
  agent._connect = (port) => { ports.push(port); return port === 5095 ? oldSocket : activeSocket; };
  agent.on('exit', () => { exits++; });

  const first = agent.ensure();
  assert.equal(agent.ensure(), first);
  children[0].stdout.write('PORT=50');
  assert.deepEqual(ports, [], 'a partial port line is not ready');
  children[0].stdout.write('95\r\n');
  assert.deepEqual(ports, [5095]);
  const refused = assert.rejects(first, /connection refused/);
  oldSocket.emit('error', new Error('synthetic connection refused'));
  await refused;
  assert.equal(agent.ready, null);
  assert.equal(children[0].kills, 1);

  const second = agent.ensure();
  children[1].stdout.write('PORT=6095\n');
  assert.deepEqual(ports, [5095, 6095]);
  children[0].emit('exit');
  oldSocket.emit('close');
  assert.equal(agent.ready, second);
  assert.equal(agent.sock, activeSocket);
  activeSocket.emit('connect');
  assert.equal(await second, agent);

  const probe = agent.probe();
  await Promise.resolve();
  assert.deepEqual(activeSocket.writes, [{ cmd: 'probe' }]);
  oldSocket.emit('data', '{"ok":true,"marker":"stale"}\n');
  activeSocket.emit('data', '{"ok":true,"marker":"current"}\n');
  assert.deepEqual(await probe, { ok: true, marker: 'current' });
  assert.equal(exits, 0);
  agent.dispose();
  assert.equal(children[1].kills, 0, 'explicit shutdown preserves the native guard');
  assert.equal(agent.ready, null);
});

test('window agent handles a child exit during handshake and reports a connected exit just once', async (t) => {
  const agent = new WinAgent();
  t.after(() => agent.dispose());
  Object.defineProperty(agent, 'available', { value: true });
  const children = [fakeAgentChild(), fakeAgentChild()];
  const sockets = [fakeAgentSocket(), fakeAgentSocket()];
  let index = 0;
  agent._spawnProcess = () => children[index];
  agent._connect = () => sockets[index];
  let exits = 0;
  agent.on('exit', () => { exits++; });

  const first = agent.ensure();
  children[0].stdout.write('PORT=5096\n');
  const failed = assert.rejects(first, /启动失败/);
  children[0].emit('exit');
  await failed;
  assert.equal(children[0].kills, 0);
  assert.equal(agent.ready, null);
  assert.equal(exits, 0);

  index = 1;
  const ready = agent.ensure();
  children[1].stdout.write('PORT=5097\n');
  sockets[1].emit('connect');
  await ready;
  sockets[1].emit('close');
  children[1].emit('exit');
  assert.equal(agent.ready, null);
  assert.equal(exits, 1);
});

test('window agent handshake remains covered by the startup deadline after PORT', async (t) => {
  const agent = new WinAgent();
  const child = fakeAgentChild();
  const socket = fakeAgentSocket();
  let fireDeadline;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    assert.equal(ms, 15000);
    fireDeadline = callback;
    return null;
  });
  t.after(() => agent.dispose());
  Object.defineProperty(agent, 'available', { value: true });
  agent._spawnProcess = () => child;
  agent._connect = () => socket;

  const pending = agent.ensure();
  child.stdout.write('PORT=5098\r\n');
  const timedOut = assert.rejects(pending, /启动超时/);
  fireDeadline();
  await timedOut;
  assert.equal(agent.ready, null);
  assert.equal(child.kills, 1);
  socket.emit('connect');
  assert.equal(agent.ready, null, 'late handshake cannot revive a timed out attempt');
});
