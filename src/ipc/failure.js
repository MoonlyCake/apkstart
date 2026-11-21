'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const { getSystemErrorMap } = require('node:util');

const invocations = new AsyncLocalStorage();
const systemCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const knownCodes = new Set([
  'ABORT_ERR', 'ADB_UNAUTHORIZED', 'APP_COMPAT_REQUIRED', 'APP_START_TIMEOUT', 'APP_UNSTABLE',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE',
  'INSTALL_FAILED_NO_MATCHING_ABIS', 'NO_MATCHING_ABIS',
]);
const sourceDir = path.resolve(__dirname, '..');
const sourceRoot = sourceDir.replaceAll('\\', '/') + '/';
const comparable = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
const comparableRoot = comparable(sourceRoot);

function sourceFrames(error) {
  const stack = error?.stack;
  if (typeof stack !== 'string') return [];
  const frames = [];
  // Error messages and command output can contain credentials or outside paths.
  // Keep only locations under the shipped source tree, without the absolute root.
  for (const line of stack.slice(-12000).split('\n').slice(1)) {
    const portable = line.trimEnd().replaceAll('\\', '/');
    if (!/^\s+at /.test(portable)) continue;
    const at = comparable(portable).lastIndexOf(comparableRoot);
    if (at < 0) continue;
    const location = /^((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js):(\d{1,7}:\d{1,7})\)?$/.exec(
      portable.slice(at + sourceRoot.length),
    );
    // Only loaded application modules are valid frame targets, not text from an error.
    if (!location || !require.cache[path.join(sourceDir, location[1])]) continue;
    const frame = `${location[1]}:${location[2]}`;
    if (!frames.includes(frame)) frames.push(frame);
    if (frames.length === 5) break;
  }
  return frames;
}

function reportIpcFailure(error) {
  const invocation = invocations.getStore();
  if (!invocation?.log || invocation.reported?.has(error)) return;
  (invocation.reported ??= new Set()).add(error);
  try {
    // The verified AEHD installer reports this exact message for a dismissed UAC prompt.
    if (error?.message === '已取消管理员授权（需要点「是」才能安装驱动）') return;
    const rawCode = error?.code;
    const code = systemCodes.has(rawCode) || knownCodes.has(rawCode) ? rawCode : 'UNEXPECTED';
    const frames = sourceFrames(error);
    invocation.log(`[ipc] ${invocation.channel} failed (${code})${frames.length ? ` at src/${frames.join(' <- src/')}` : ''}`);
  } catch (_) { /* Diagnostics must never change the IPC result. */ }
}

function ipcFailure(error) {
  reportIpcFailure(error);
  return { ok: false, error: error.message };
}

function withIpcDiagnostics(channel, log, run) {
  if (typeof log !== 'function') return run();
  const invocation = { channel, log };
  return invocations.run(invocation, () => {
    const finish = () => {
      // Timers started by a handler may outlive its invocation.
      invocation.log = invocation.reported = null;
    };
    try {
      const result = run();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then((value) => {
          finish();
          return value;
        }, (error) => {
          reportIpcFailure(error);
          finish();
          throw error;
        });
      }
      finish();
      return result;
    } catch (error) {
      reportIpcFailure(error);
      finish();
      throw error;
    }
  });
}

module.exports = { ipcFailure, reportIpcFailure, withIpcDiagnostics };
