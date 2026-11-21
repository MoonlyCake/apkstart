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
