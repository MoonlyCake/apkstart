'use strict';

function createAgentSession({ createAgent, scopeDirs, ownerPid, wheelRouter, wheelMode, onBack, onForward, onReplace, log }) {
  let disposed = false;
  let current = createAgent();
  const isCurrent = (agent) => !disposed && agent === current;

  async function arm(agent = current) {
    if (!isCurrent(agent)) return { ok: false };
    const dirs = scopeDirs();
    await agent.scope(dirs, ownerPid).catch(() => null);
    if (!isCurrent(agent)) return { ok: false };
    if (!dirs.length) log('agent scope 为空：不压制任何窗口（避免误伤其他软件）');
    return agent.bootHide().catch(() => ({ ok: false }));
  }

  async function presentAdbConsent(identity) {
    const agent = current;
    const pid = identity?.pid;
    if (!isCurrent(agent) || !Number.isInteger(pid) || pid <= 0
      || typeof identity.revalidate !== 'function' || typeof agent.reserveAdbConsent !== 'function') return null;
    let lease;
    let shown = false;
    try {
      lease = await agent.reserveAdbConsent(pid);
      // The helper has pinned a native window; recheck the runtime before showing it.
      if (!lease || !isCurrent(agent) || !await identity.revalidate() || !isCurrent(agent)) return null;
      if (!await lease.show() || !isCurrent(agent)) return null;
      shown = true;
      return async () => {
        if (!shown) return;
        shown = false;
        await lease.close().catch(() => {});
      };
    } catch (_) {
      return null;
    } finally {
      if (!shown && lease) await lease.close().catch(() => {});
    }
  }

  function subscribe(agent) {
    agent.on('back', () => { if (isCurrent(agent)) onBack().catch(() => {}); });
    agent.on('forward', () => { if (isCurrent(agent)) onForward().catch(() => {}); });
    agent.on('wheel', (value) => { if (isCurrent(agent) && wheelMode() === 'smooth') wheelRouter.push(value); });
    agent.on('exit', () => {
      // A late event from an old helper must not replace the live agent.
      if (!isCurrent(agent)) return;
      current = createAgent();
      subscribe(current);
      onReplace(current);
      arm(current).catch(() => {});
    });
  }
  subscribe(current);

  return {
    get current() { return current; },
    arm,
    presentAdbConsent,
    preconnect() {
      const agent = current;
      return agent.ensure().then(() => arm(agent)).catch(() => ({ ok: false }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { current.dispose(); } finally { wheelRouter.dispose(); }
    },
  };
}

module.exports = { createAgentSession };
