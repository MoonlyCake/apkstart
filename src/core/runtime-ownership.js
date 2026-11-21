'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const AVD_NAME = 'apkstart';

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** A missing/dead lock is different from a lock we cannot read or interpret. */
function readAvdOwner(avdHome, { isAlive = processAlive } = {}) {
  try {
    const avd = path.join(avdHome, `${AVD_NAME}.avd`);
    const avdStat = fs.lstatSync(avd, { throwIfNoEntry: false });
    if (!avdStat) return { state: 'absent' };
    if (!avdStat.isDirectory()) return { state: 'unknown' };
    const lock = path.join(avd, 'hardware-qemu.ini.lock');
    const lockStat = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (!lockStat) return { state: 'absent' };
    const pidFile = lockStat.isDirectory() ? path.join(lock, 'pid') : lock;
    const pidStat = lockStat.isDirectory() ? fs.lstatSync(pidFile, { throwIfNoEntry: false }) : lockStat;
    if (!pidStat?.isFile() || pidStat.size > 64) return { state: 'unknown' };
    const text = fs.readFileSync(pidFile, 'utf8').replace(/\0$/, '').trim();
    const pid = Number(text);
    if (!/^[1-9]\d*$/.test(text) || pid > 0x7fffffff || pid === process.pid) return { state: 'unknown' };
    return { state: isAlive(pid) ? 'live' : 'stale', pid, generation: `${pidStat.ino}:${pidStat.mtimeMs}` };
  } catch (_) {
    return { state: 'unknown' };
  }
}

function isConsolePort(port) {
  // Android Emulator assigns consoles even ports and adbd the adjacent odd port.
  return Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0;
}

function addListener(ports, endpoint, pids) {
  const m = /^(127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\[?::\]?|\[?::ffff:127\.0\.0\.1\]?|\*):(\d+)$/i.exec(endpoint);
  if (!m) return;
  const port = Number(m[2]);
  if (!ports.has(port)) ports.set(port, new Set());
  for (const pid of pids) ports.get(port).add(pid);
}

function parseWindowsListeners(stdout) {
  const ports = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    // A TCP listener has an unspecified remote address and port zero. Avoid relying on
    // the localized state column, and check the local endpoint only.
    const m = /^\s*TCP\s+(\S+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/i.exec(line);
    // ADB's Windows client connects to 127.0.0.1 (AF_INET), not ::1.
    if (m && /^(?:127\.0\.0\.1|0\.0\.0\.0):/.test(m[1])) addListener(ports, m[1], [Number(m[2])]);
  }
  return ports;
}

function parseLinuxListeners(stdout) {
  const ports = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+(.*)$/i.exec(line);
    if (!m) continue;
    const pids = [...m[2].matchAll(/\bpid=(\d+)/g)].map((entry) => Number(entry[1]));
    addListener(ports, m[1], pids.length ? pids : [0]); // missing PID is ambiguous, not empty
  }
  return ports;
}

function readLoopbackOwners(platform = process.platform) {
  if (platform !== 'win32' && platform !== 'linux') return Promise.resolve(new Map());
  const windows = platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(windows ? 'netstat' : 'ss', windows ? ['-ano'] : ['-Hltnp'], {
      timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      return resolve((windows ? parseWindowsListeners : parseLinuxListeners)(stdout));
    });
  });
}

function ownsPort(listeners, port, pid) {
  const owners = listeners.get(port);
  return !!owners && owners.size === 1 && owners.has(pid);
}

async function readConsoleName(client) {
  const { stdout } = await client.exec(['emu', 'avd', 'name'], { timeout: 3000 });
  const name = String(stdout || '').trim().replace(/\r?\nOK$/, '');
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : '';
}

/** Bind a detached or tracked emulator to the active AVD, not just to an ADB serial. */
async function findOwnedEmulator({ readOwner, readListeners, consoleClient }) {
  try {
    const owner = readOwner();
    if (owner.state === 'absent' || owner.state === 'stale') return { state: 'absent' };
    if (owner.state !== 'live') return { state: 'unknown' };
    const listeners = await readListeners();
    const ports = [...listeners.keys()].filter((port) => isConsolePort(port) && ownsPort(listeners, port, owner.pid));
    if (ports.length !== 1) return { state: 'unknown' };
    const [port] = ports;
    const serial = `emulator-${port}`;
    const client = consoleClient(serial);
    const revalidate = async ({ adbPort = false } = {}) => {
      try {
        const current = await readListeners();
        const lock = readOwner();
        return lock.state === 'live' && lock.pid === owner.pid && lock.generation === owner.generation
          && ownsPort(current, port, owner.pid) && (!adbPort || ownsPort(current, port + 1, owner.pid));
      } catch (_) { return false; }
    };
    if (await readConsoleName(client) !== AVD_NAME || !(await revalidate())) return { state: 'unknown' };
    return { state: 'owned', emulator: { port, pid: owner.pid, serial, client, revalidate } };
  } catch (_) {
    return { state: 'unknown' };
  }
}

module.exports = {
  AVD_NAME, processAlive, readAvdOwner, isConsolePort, readConsoleName, findOwnedEmulator,
  readLoopbackOwners, parseWindowsListeners, parseLinuxListeners, ownsPort,
};
