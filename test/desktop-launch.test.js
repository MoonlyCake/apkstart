'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');
const { createLaunchPresentation } = require('../src/desktop/launch-presentation');
const { createAgentSession } = require('../src/desktop/agent-session');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function launchFixture({ detached = false, attach, firstFrame, openDetached }) {
  const calls = [];
  const timers = new Map();
  let current = true;
  let owner;
  let ownerAtStart;
  const shell = (name) => ({
    show() { calls.push([name, 'show']); },
    setAlwaysOnTop(on) { calls.push([name, 'top', on]); },
    moveTop() { calls.push([name, 'move']); },
    focus() { calls.push([name, 'focus']); },
  });
  const window = {
    win: shell('original'), isOpen: true,
    openDetached: openDetached || (() => Promise.resolve(false)),
    setState: (state) => calls.push(['state', state]),
  };
  owner = ownerAtStart = window.win;
  const presentation = createLaunchPresentation({
    pkg: 'com.fixture.app',
    getWindow: () => window,
    isCurrent: () => current && owner === ownerAtStart,
    ownsWindow: () => owner === ownerAtStart,
    isDetached: () => detached,
    attach,
    firstFrame,
    finishSplash: () => calls.push(['splash']),
    mark: (value) => calls.push(['mark', value]),
    log: (value) => calls.push(['log', value]),
    schedule(task, ms) {
      const id = Symbol(String(ms));
      timers.set(id, { task, ms });
      return id;
    },
    cancel(id) { timers.delete(id); },
  });

  return {
    presentation, calls, timers, window,
    fire(ms) {
      const [id, job] = [...timers].find(([, entry]) => entry.ms === ms);
      timers.delete(id);
      job.task();
    },
    replaceWindow() { owner = window.win = shell('replacement'); },
    closeSession() { current = false; },
  };
}

test('final setup waits for the native discovery already underway and reuses successful early attachment', async () => {
  const discovering = deferred();
  const frame = deferred();
  let attempts = 0;
  const fixture = launchFixture({
    detached: true,
    openDetached: () => discovering.promise,
    attach: async (isCurrent) => { attempts += 1; return isCurrent(); },
    firstFrame: (pkg, options) => {
      assert.equal(pkg, 'com.fixture.app');
      assert.deepEqual(options, { timeoutMs: 20000 });
      return frame.promise;
    },
  });
  const { presentation, calls, timers } = fixture;
  presentation.startDiscovery();
  presentation.startEarly();
  const final = presentation.finishAttachment();
  await tick();
  assert.equal(attempts, 0);
  discovering.resolve(false);
  assert.equal(await final, true);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
  assert.equal([...timers.values()].some((timer) => timer.ms === 1500), false);

  frame.resolve(true);
  await tick();
  assert.deepEqual(calls, [['mark', 'first frame=true'], ['state', { ready: true, tip: '' }], ['splash']]);
  assert.equal(timers.size, 0);
});

test('embedded fallback retries once; delayed topmost reset and frame completion cannot affect replacement', async () => {
  const frame = deferred();
  let attempts = 0;
  const fixture = launchFixture({
    attach: async () => ++attempts === 2,
    firstFrame: () => frame.promise,
  });
  const { presentation, calls } = fixture;
  presentation.startEarly();
  assert.equal(await presentation.finishAttachment(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [
    ['original', 'show'], ['original', 'top', true], ['original', 'move'], ['original', 'focus'],
  ]);
  fixture.replaceWindow();
  fixture.fire(700);
  frame.resolve(true);
  await tick();
  fixture.fire(24000);
  assert.equal(calls.length, 4);
});

test('native discovery pauses during repaneling and abort cancels a pending retry', async () => {
  let probes = 0;
  const fixture = launchFixture({
    detached: true,
    attach: async () => false,
    firstFrame: async () => assert.fail('no successful attachment'),
    openDetached: async () => { probes += 1; return false; },
  });
  const { window, presentation, calls, timers } = fixture;
  window.waitingForRestart = true;
  presentation.startDiscovery();
  assert.equal(probes, 0);
  window.waitingForRestart = false;
  fixture.fire(1500);
  await tick();
  assert.equal(probes, 1);
  fixture.closeSession();
  await presentation.abort();
  assert.deepEqual(calls, [['state', { ready: true, tip: '' }], ['splash']]);
  assert.equal(timers.size, 0);
});

test('startup timeout retires an incomplete animation once without waiting for the first frame', async () => {
  const frame = deferred();
  const fixture = launchFixture({
    detached: true,
    attach: async () => true,
    firstFrame: () => frame.promise,
  });
  const { presentation, calls, timers } = fixture;
  assert.equal(await presentation.finishAttachment(), true);
  assert.deepEqual(calls, []);
  fixture.fire(24000);
  frame.resolve(true);
  await tick();
  await presentation.abort();
  assert.deepEqual(calls.filter(([kind]) => kind === 'splash' || kind === 'state'),
    [['state', { ready: true, tip: '' }], ['splash']]);
  assert.equal(timers.size, 0);
});

test('a replacement native agent is scoped before use; stale agents cannot affect it or route input', async () => {
  const oldScope = deferred();
  const entries = [];
  const agents = [];
  const createAgent = () => {
    const id = agents.length;
    const agent = new EventEmitter();
    agent.scope = async (dirs, owner) => {
      entries.push(['scope', id, dirs, owner]);
      if (id === 0) await oldScope.promise;
    };
    agent.bootHide = async () => { entries.push(['hide', id]); return { ok: true }; };
    agent.dispose = () => entries.push(['dispose', id]);
    agents.push(agent);
    return agent;
  };
  const session = createAgentSession({
    createAgent, scopeDirs: () => ['/fixture/engine'], ownerPid: 812,
    wheelRouter: { push: (value) => entries.push(['wheel', value]), dispose: () => entries.push(['wheel-dispose']) },
    wheelMode: () => 'smooth',
    onBack: async () => entries.push(['back']), onForward: async () => entries.push(['forward']),
    onReplace: (agent) => entries.push(['replace', agents.indexOf(agent)]),
    log: () => {},
  });
  const oldArm = session.arm();
  agents[0].emit('exit');
  oldScope.resolve();
  assert.deepEqual(await oldArm, { ok: false });
  assert.equal(session.current, agents[1]);
  agents[0].emit('exit');
  agents[0].emit('back');
  agents[1].emit('wheel', 9);
  session.dispose();
  session.dispose();
  agents[1].emit('exit');
  agents[1].emit('forward');
  assert.deepEqual(entries, [
    ['scope', 0, ['/fixture/engine'], 812], ['replace', 1], ['scope', 1, ['/fixture/engine'], 812],
    ['hide', 1], ['wheel', 9], ['dispose', 1], ['wheel-dispose'],
  ]);
  assert.equal(agents.length, 2);
});
