'use strict';

const { createWindowAttachment } = require('../application/window-attachment');

function createLaunchPresentation({
  pkg, getWindow, isCurrent, ownsWindow, isDetached, attach, firstFrame,
  finishSplash, mark, log, canShowWait = () => true, schedule = setTimeout, cancel = clearTimeout,
}) {
  let finishing = false;
  let splashFinished = false;
  let attached = false;
  let animationElapsed = false;
  let framePending = false;
  let discovering = true;
  let discoveryTimer;
  let discoveryPending;

  async function stopDiscovery() {
    discovering = false;
    if (discoveryTimer !== undefined) cancel(discoveryTimer);
    await discoveryPending;
  }

  const attachment = createWindowAttachment(async () => {
    // Never move the same native window from two asynchronous attempts.
    await stopDiscovery();
    return isCurrent() && await attach(isCurrent);
  });
  const animationTimer = schedule(() => {
    animationElapsed = true;
    finishAnimation();
  }, 24000);
  animationTimer?.unref?.();

  function finishOwnedSplash() {
    if (splashFinished || !ownsWindow()) return;
    splashFinished = true;
    finishSplash();
  }

  function finishAnimation() {
    if (finishing || !ownsWindow() || !isCurrent()) return;
    if (!attached) {
      // The animation deadline is not evidence of a native surface.
      if (canShowWait()) getWindow()?.showWaitSurface?.({ activate: false });
      finishOwnedSplash();
      return;
    }
    finishing = true;
    cancel(animationTimer);
    const window = getWindow();
    if (window?.isOpen) window.setState({ ready: true, tip: '' });
    finishOwnedSplash();
  }

  async function watchFirstFrame(confirmed) {
    if (!confirmed || !isCurrent()) return;
    attached = true;
    if (animationElapsed) return finishAnimation();
    if (framePending || finishing) return;
    framePending = true;
    let painted = false;
    try {
      painted = await firstFrame(pkg, { timeoutMs: 20000 });
    } catch (_) { /* Semantics: a missing frame probe does not hold the splash indefinitely. */ }
    if (!isCurrent()) return;
    mark(`first frame=${painted}`);
    finishAnimation();
  }

  function startDiscovery() {
    if (!isDetached() || !getWindow()?.isOpen) return;
    let tries = 0;
    let rounds = 0;
    function probe() {
      const target = getWindow();
      const shell = target?.win;
      const active = () => isCurrent() && discovering && target?.isOpen && target === getWindow()
        && target.win === shell && isDetached();
      if (!active() || ++rounds > 45) return;
      const next = () => { discoveryTimer = schedule(probe, 1500); };
      if (target.waitingForRestart) { next(); return; }
      tries += 1;
      discoveryPending = target.openDetached(active).catch(() => false).then((ok) => {
        if (!active()) return;
        if (ok) log(`pre-attach detached ok（第 ${tries} 次）`);
        else if (tries < 20) next();
      });
    }
    probe();
  }

  function surfaceEmbeddedWindow() {
    const target = getWindow();
    const shell = target?.win;
    if (!target?.isOpen || (target.detachedMode ?? isDetached())) return;
    try {
      shell.show();
      shell.setAlwaysOnTop(true);
      shell.moveTop();
      shell.focus();
      schedule(() => {
        if (getWindow() !== target || !target.isOpen || target.win !== shell) return;
        try { shell.setAlwaysOnTop(false); } catch (_) { /* The window may have closed. */ }
      }, 700);
    } catch (_) { /* The window may have closed. */ }
  }

  return {
    startDiscovery,
    startEarly() { attachment.startEarly().then(watchFirstFrame); },
    async finishAttachment() {
      const confirmed = await attachment.finish();
      if (!isCurrent() || !confirmed) return false;
      watchFirstFrame(confirmed);
      surfaceEmbeddedWindow();
      return true;
    },
    async abort() {
      finishing = true;
      cancel(animationTimer);
      await stopDiscovery();
      await attachment.settleEarly();
      finishOwnedSplash();
    },
  };
}

module.exports = { createLaunchPresentation };
