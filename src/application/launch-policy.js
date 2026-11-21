'use strict';

const { performance } = require('node:perf_hooks');

const policyDefaults = {
  observeMs: 25000,
  stableMs: 4000,
  pollMs: 700,
  probeMs: 6000,
  maxAttempts: 3,
};

function launchError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

// probe({ timeout }) must return verified PID strings (or [] for a verified
// absence) and reject on transport failure. Only a surviving PID, observed on
// both sides of the stability window with no missing samples, is success.
async function runLaunchPolicy({
  start,
  probe,
  onStarted = () => {},
  onAppUp,
  assertCurrent = () => {},
  onMark = () => {},
  onLog = () => {},
}, {
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...options
} = {}) {
  const { observeMs, stableMs, pollMs, probeMs, maxAttempts } = { ...policyDefaults, ...options };
  let announced = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertCurrent();
    let seen = false;
    try {
      // startApp may have seen a real PID before display adjustment begins.
      // Preserve evidence of a sighting, but not its elapsed stability time.
      await start(() => { seen = true; });
    } catch (error) {
      onMark('am start #' + attempt + ' fail');
      // startApp already does its own intent/monkey fallback. Preserve its
      // original error and crash record rather than treating failed ADB as exit.
      throw error;
    }
    onMark('am start #' + attempt + ' ok');
    await onStarted();

    const deadline = now() + observeMs;
    let sightings = new Map();
    let consecutiveAbsent = 0;
    let lastProbeError = null;
    let exited = false;
    while (now() < deadline) {
      assertCurrent();
      let pids = null;
      try {
        pids = await probe({ timeout: Math.min(probeMs, Math.max(1, Math.floor(deadline - now()))) });
        lastProbeError = null;
      } catch (error) {
        lastProbeError = error;
      }
      assertCurrent();
      const time = now();
      if (time > deadline) break;
      if (pids === null) {
        // Unknown interrupts both the stability window and consecutive absence.
        sightings = new Map();
        consecutiveAbsent = 0;
      } else if (pids.length === 0) {
        sightings = new Map();
        if (seen && ++consecutiveAbsent >= 2) {
          exited = true;
          break;
        }
      } else {
        consecutiveAbsent = 0;
        seen = true;
        if (!announced && typeof onAppUp === 'function') {
          announced = true;
          // Window attachment is a notification, not a liveness dependency.
          try { Promise.resolve(onAppUp()).catch(() => {}); } catch (_) { /* optional notification */ }
        }
        sightings = new Map(pids.map((pid) => [pid, sightings.get(pid) ?? time]));
        if ([...sightings.values()].some((first) => time - first >= stableMs)) {
          onMark('alive #' + attempt + ' true');
          return;
        }
      }
      const pause = Math.min(pollMs, deadline - now());
      if (pause > 0) await sleep(pause);
    }

    if (exited) {
      onMark('alive #' + attempt + ' false (exit observed)');
      if (attempt < maxAttempts) {
        onLog('应用进程已退出（第 ' + attempt + ' 次），正在自动重试…');
        await sleep(600 * attempt);
        continue;
      }
      throw launchError('APP_UNSTABLE', '应用启动后反复退出，未执行清除应用数据。请检查应用日志后重试。');
    }

    if (lastProbeError) {
      onMark('alive #' + attempt + ' unknown (ADB probe failed)');
      throw launchError(
        'APP_OBSERVATION_FAILED',
        '无法通过 ADB 确认应用是否已启动。请检查运行时连接后重试。',
        lastProbeError,
      );
    }

    onMark('alive #' + attempt + ' unknown (observation timed out)');
    throw launchError(
      'APP_START_TIMEOUT',
      '等待应用进程稳定超时，应用可能仍在加载。未执行清除应用数据。',
    );
  }
}

module.exports = { runLaunchPolicy };
