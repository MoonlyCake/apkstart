'use strict';

const { isIP } = require('node:net');

const WIFI_STATUS = 'cmd wifi status 2>/dev/null; printf "\\n__APKSTART_VALIDATION_MODE__="; settings get global captive_portal_mode';
const SNAPSHOT_COMMAND = 'dumpsys connectivity';
const STOCK_WIFI_BSSIDS = new Set(['02:15:b2:00:01:00', '02:15:b2:00:00:01']);
const stockWifiConnect = (bssid) => `cmd wifi connect-network AndroidWifi open -b ${bssid}`;
const STOCK_WIFI_CONNECT = stockWifiConnect('02:15:b2:00:01:00');
const REACHABILITY_CHECK =
  'printf "GET /generate_204 HTTP/1.0\\r\\nHost: connect.rom.miui.com\\r\\n\\r\\n"'
  + ' | nc -w 4 connect.rom.miui.com 80 2>/dev/null | head -1';

// Query Android's current default, not the first IPv4 on any interface. In particular,
// radio0 can keep 10.0.2.15 while it is DOWN and there is no Android default network.
function inspectConnectivity(dump, wifi) {
  const wifiConnected = /^\s*Wi-?Fi is connected\b/im.test(wifi);
  const inactiveWifi = /^\s*Wi-?Fi is enabled\b/im.test(wifi)
    && /^\s*Wi-?Fi is not connected\b/im.test(wifi);
  const validationMode = /^__APKSTART_VALIDATION_MODE__=(\S+)/m.exec(wifi)?.[1];
  const defaultId = /^\s*Active default network:\s*(\S+)/im.exec(dump)?.[1];
  const disconnected = { ok: false, wifiConnected, reachable: false };
  if (/^(none|null)$/i.test(defaultId || '')) {
    return { result: { ...disconnected, reason: inactiveWifi ? 'wifi-not-connected' : 'no-default-network' } };
  }
  const unverified = { ok: false, reason: 'internet-unverified', wifiConnected, reachable: null, validated: false };
  if (!/^\d+$/.test(defaultId || '')) return { result: unverified };
  const networkId = Number(defaultId);
  const info = dump.split(/^\s*NetworkAgentInfo\s*\{/m).slice(1).find((record) =>
    /\bnetwork\s*\{(\d+)\}/i.exec(record)?.[1] === defaultId);
  if (!info) return { result: { ...unverified, networkId } };
  const caps = (/\bCapabilities:\s*([A-Z_0-9]+(?:\s*[&|]\s*[A-Z_0-9]+)*)/.exec(info)?.[1] || '')
    .split(/\s*[&|]\s*/);
  // Establish that addresses and routes come from this agent's LinkProperties. Do not
  // borrow an interface or a route from another current network or from the event log.
  const iface = /\bInterfaceName:\s*(\S+)/.exec(info)?.[1];
  if (!iface) return { result: { ...unverified, networkId } };
  const low = { ...disconnected, networkId };
  const addresses = (/\bLinkAddresses:\s*\[([^\]]*)\]/.exec(info)?.[1] || '')
    .split(/[\s,]+/).map((entry) => entry.split('/')[0]).filter(isUsableAddress);
  if (!addresses.length) return { result: { ...low, reason: 'no-ip-address' } };
  const routes = (/\bRoutes:\s*\[([^\]]*)\]/.exec(info)?.[1] || '')
    .split(',').map((entry) => /^(0\.0\.0\.0\/0|::\/0)\s*->\s*(\S+)\s+(\S+)/.exec(entry.trim()))
    .filter((route) => route && route[3] === iface && isIP(route[2]));
  const route = [4, 6].map((family) => addresses.some((ip) => isIP(ip) === family)
    && routes.find((entry) => isIP(entry[2]) === family)).find(Boolean);
  if (!route) return { result: { ...low, reason: 'no-default-route' } };
  const gateway = route[2];
  const ip = addresses.find((addr) => isIP(addr) === isIP(gateway));
  const hasInternet = caps.includes('INTERNET') && !caps.includes('CAPTIVE_PORTAL')
    && !caps.includes('PARTIAL_CONNECTIVITY') && !/\b(?:state:\s*)?DISCONNECTED\/DISCONNECTED\b/.test(info);
  // Older builds disabled Android's normal validation. Do not mistake the OS's
  // permissive bit in that profile for an independent internet check.
  const validated = hasInternet && ['null', '1', '2'].includes(validationMode) && caps.includes('VALIDATED');
  const base = { ...unverified, networkId, ip, gateway, validated };
  if (validated) return { result: { ...base, ok: true, reason: '', reachable: true } };
  return { result: base, probeKey: hasInternet ? JSON.stringify([networkId, iface, ip, gateway]) : null };
}

function isUsableAddress(ip) {
  return isIP(ip) === 4 ? !/^(?:127\.|169\.254\.|0\.)/.test(ip)
    : isIP(ip) === 6 && !/^(?:fe[89ab]|::(?:1)?$)/i.test(ip);
}

function stockWifiBssid(scanResults) {
  // Never connect to an arbitrary SSID or a look-alike with a different virtual BSSID.
  // The shipped images use different radio addresses; always select the one actually scanned.
  const candidates = new Set();
  for (const row of String(scanResults).split(/\r?\n/)) {
    const match = /^[ \t]*([0-9a-f:]+)[ \t]+\S+[ \t]+\S+[ \t]+\S+[ \t]+AndroidWifi[ \t]+\[ESS\][ \t]*$/i.exec(row);
    const bssid = match?.[1].toLowerCase();
    if (STOCK_WIFI_BSSIDS.has(bssid)) candidates.add(bssid);
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function isStockWifiVisible(scanResults) {
  return stockWifiBssid(scanResults) !== null;
}

const pauseFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const changed = () => ({ ok: false, reason: 'guest-changed' });
const offline = () => ({ ok: false, reason: 'device-offline' });
const unknown = () => ({ ok: false, reason: 'internet-unverified', reachable: null });

async function checkGuestNetwork(client, { waitMs = 0, interval = 3000, verifyInternet = waitMs > 0,
  canProbe = async () => true, pause = pauseFor, now = Date.now } = {}) {
  const deadline = waitMs > 0 ? now() + waitMs : verifyInternet ? now() + 9000 : null;
  const budget = (cap) => deadline === null ? cap : Math.min(cap, deadline - now());
  const read = async (command, maxMs = 8000) => {
    if (!await canProbe()) return { result: changed() };
    const timeout = budget(maxMs);
    if (timeout <= 0) return { expired: true };
    let output;
    let error;
    try { output = String(await client.shell(command, { timeout })); } catch (err) { error = err; }
    if (!await canProbe()) return { result: changed() };
    return { output, error };
  };
  const inspect = async () => {
    const wifi = await read(WIFI_STATUS);
    if (wifi.result || wifi.expired) return wifi;
    const connectivity = await read(SNAPSHOT_COMMAND);
    if (connectivity.result || connectivity.expired) return connectivity;
    if (connectivity.error) {
      const text = String(connectivity.error.raw || connectivity.error.message || '');
      return { result: /(?:device.{0,100}(?:offline|unauthorized|not found)|no devices\/emulators found|connection refused)/i.test(text)
        ? offline() : unknown() };
    }
    return inspectConnectivity(connectivity.output, wifi.output || '');
  };
  let last = unknown();
  let triedKey;
  let failedProbe = false;
  for (;;) {
    const snapshot = await inspect();
    if (snapshot.expired) return last;
    last = snapshot.result;
    if (last.ok || ['guest-changed', 'device-offline'].includes(last.reason)) return last;
    if (snapshot.probeKey && triedKey === snapshot.probeKey && failedProbe) last.reachable = false;
    if (verifyInternet && snapshot.probeKey && triedKey !== snapshot.probeKey && budget(4500) > 0) {
      triedKey = snapshot.probeKey;
      const http = await read(REACHABILITY_CHECK, 4500);
      if (http.result) return http.result;
      if (http.expired) return last;
      failedProbe = !/^HTTP\/1\.[01]\s+204\b/i.test(http.output || '');
      if (failedProbe) last.reachable = false;
      else {
        // The Android default can move while a probe is in flight. Never publish
        // success for the old interface, even if we're still on the same guest.
        const current = await inspect();
        if (current.expired) return last;
        if (current.result.ok || ['guest-changed', 'device-offline'].includes(current.result.reason)) return current.result;
        if (current.probeKey === triedKey) return { ...current.result, ok: true, reason: '', reachable: true };
        last = current.result;
      }
    }
    const remaining = budget(Infinity);
    if (waitMs <= 0 || remaining <= 0) return last;
    await pause(Math.min(Math.max(1, interval), remaining));
    if (now() >= deadline) return last;
  }
}

async function repairStockWifi(client, { canMutate = async () => true, pause = pauseFor, now = Date.now } = {}) {
  const check = (waitMs = 0) => checkGuestNetwork(client, { waitMs, interval: 800, canProbe: canMutate, pause, now });
  const initial = await check();
  if (initial.ok) return true;
  if (initial.reason === 'internet-unverified') {
    // Existing links need verification, not a disruptive reconnect.
    return (await checkGuestNetwork(client, { verifyInternet: true, canProbe: canMutate, pause, now })).ok;
  }
  if (initial.reason !== 'wifi-not-connected') return false;
  const command = async (cmd, timeout = 4000) => {
    if (!await canMutate()) return null;
    try {
      const output = String(await client.shell(cmd, { timeout }));
      return await canMutate() ? output : null;
    } catch (_) { return null; }
  };
  const scan = await command('cmd wifi list-scan-results');
  if (scan === null) return false;
  let bssid = stockWifiBssid(scan);
  if (!bssid) {
    if (await command('cmd wifi start-scan') === null) return false;
    // start-scan acknowledges that Android queued the scan, not that results arrived.
    const scanDeadline = now() + 5500;
    for (const interval of [800, 1200, 1800, 1200]) {
      const available = scanDeadline - now();
      if (available <= 0) break;
      await pause(Math.min(interval, available));
      const timeout = Math.min(4000, scanDeadline - now());
      if (timeout <= 0) break;
      const results = await command('cmd wifi list-scan-results', timeout);
      if (results === null) return false;
      bssid = stockWifiBssid(results);
      if (bssid) break;
    }
    if (!bssid) return false;
  }
  const beforeConnect = await check();
  if (beforeConnect.ok) return true;
  if (beforeConnect.reason !== 'wifi-not-connected') return false;
  // Shell accepts this command on stock images. "Connection initiated" only
  // acknowledges the request, so require verified guest connectivity afterwards.
  if (await command(stockWifiConnect(bssid)) === null) return false;
  return (await check(12000)).ok;
}

module.exports = {
  WIFI_STATUS, SNAPSHOT_COMMAND, REACHABILITY_CHECK, STOCK_WIFI_CONNECT, inspectConnectivity, isStockWifiVisible,
  checkGuestNetwork, repairStockWifi,
};
