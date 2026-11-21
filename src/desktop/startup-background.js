'use strict';

function createStartupBackground({ log, send, now = Date.now, setTimer = setTimeout }) {
  const later = (task, ms) => setTimer(task, ms)?.unref?.();

  function scheduleDiagnostics({ initialize, run }) {
    initialize();
    later(() => { run().catch(() => {}); }, 25000);
  }

  function scheduleRuntime({ args, settings, apps, runtime, getAgent, armAgent, autoDeploy }) {
    const prewarmEnabled = settings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && apps().length > 0) {
      later(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            log(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // Do not spawn until the window guard is armed.
          const agent = getAgent();
          if (agent) await armAgent(agent).catch(() => {});
          const started = now();
          log('prewarm start');
          const result = await runtime.prewarm({ onLog: (message) => log(`prewarm ${message}`) });
          if (result?.ok) {
            log(`prewarm ready in ${now() - started}ms`);
          } else {
            log(`prewarm failed: ${result && (result.error || result.skipped)}`);
            const currentAgent = getAgent();
            if (currentAgent) armAgent(currentAgent).catch(() => {});
          }
        } catch (error) {
          log('prewarm error: ' + error.message);
        }
      }, 1200);
    } else {
      log(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${apps().length})`);
    }

    // First-run downloads should not compete with Electron's startup.
    later(() => {
      autoDeploy().then((result) => {
        if (result?.ok) send('toast', { type: 'ok', message: '安卓运行时组件已准备完成' });
      }).catch(() => {});
    }, 20000);
  }

  function scheduleUpdates({ packaged, storeBuild, updater, version, setInfo, requestQuit }) {
    if (!packaged || storeBuild) return;

    try {
      const job = updater.findResumableJob();
      if (job) {
        // Replay a verified cached update rather than download it again.
        log(`resuming pending update ${job.version} from cached payload`);
        send('update:progress', { stage: 'apply', percent: 100, message: '正在完成上次未完成的更新…' });
        try {
          updater.apply(job);
          setTimer(requestQuit, 900);
        } catch (error) {
          log('resume check failed: ' + error.message);
        }
        return;
      }
    } catch (error) {
      log('resume check failed: ' + error.message);
    }

    later(() => {
      updater.check().then((info) => {
        setInfo(info);
        send('update:state', info);
        if (info.hasUpdate) {
          log(`update available ${info.tag} (current v${version()}, asset=${info.asset ? info.asset.name : 'none'})`);
        }
      }).catch((error) => log('update check failed: ' + error.message));
    }, 8000);
  }

  return { scheduleDiagnostics, scheduleRuntime, scheduleUpdates };
}

module.exports = { createStartupBackground };
