'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WinAgent } = require('../src/core/agent');

function fixture() {
  const agent = new WinAgent();
  const requests = [];
  agent.call = (request) => new Promise((resolve, reject) => {
    requests.push({ request, resolve, reject });
  });
  return { agent, requests };
}

test('losing focus while a native hook is being enabled still sends the disable', async () => {
  const { agent, requests } = fixture();
  const enabling = agent.setHook(true, { rightBack: true });
  const disabling = agent.setHook(false);
  assert.deepEqual(requests.map(({ request }) => request.on), [1, 0]);

  requests[0].resolve({ ok: true, hooked: true });
  assert.deepEqual(await enabling, { ok: true, hooked: true });
  requests[1].resolve({ ok: true, hooked: false });
  assert.deepEqual(await disabling, { ok: true, hooked: false });
  assert.equal(agent.hooked, false);
});

test('an unacknowledged enable cannot make the next disable a no-op', async () => {
  const { agent, requests } = fixture();
  const enabling = agent.setHook(true, { wheel: true });
  requests[0].reject(new Error('synthetic native request timeout'));
  assert.deepEqual(await enabling, { ok: false, hooked: false });

  const disabling = agent.setHook(false);
  assert.deepEqual(requests.map(({ request }) => request.on), [1, 0]);
  requests[1].resolve({ ok: true, hooked: false });
  assert.deepEqual(await disabling, { ok: true, hooked: false });
  assert.deepEqual(await agent.setHook(false), { ok: true, hooked: false });
  assert.equal(requests.length, 2, 'a confirmed disabled helper need not be called again');
});

test('a native response without hook confirmation is not treated as enabled', async () => {
  const { agent, requests } = fixture();
  const enabling = agent.setHook(true, { side: true });
  requests[0].resolve({ ok: false });
  assert.deepEqual(await enabling, { ok: false, hooked: false });
  assert.equal(agent.hooked, false);
});

test('a hook acknowledgement from a disposed client cannot revive the reported hook state', async () => {
  const { agent, requests } = fixture();
  agent._attempt = { reject() {}, connected: true };
  const enabling = agent.setHook(true, { rightBack: true });
  agent.dispose();
  requests[0].resolve({ ok: true, hooked: true });
  assert.deepEqual(await enabling, { ok: false, hooked: false });
  assert.equal(agent.hooked, false);
});
