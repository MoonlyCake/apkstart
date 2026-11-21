'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  checkGuestNetwork, repairStockWifi, inspectConnectivity, isStockWifiVisible,
  SNAPSHOT_COMMAND, WIFI_STATUS, REACHABILITY_CHECK, STOCK_WIFI_CONNECT,
} = require('../src/core/emulator-network');

const WIFI = 'Wifi is enabled\nWifi is connected to "AndroidWifi"\n__APKSTART_VALIDATION_MODE__=null';
const DOWN = 'Wifi is enabled\nWifi is not connected\n__APKSTART_VALIDATION_MODE__=null';
const STOCK = '    02:15:b2:00:01:00       2447        -30          1.538    AndroidWifi                       [ESS]';
const route = '0.0.0.0/0 -> 10.0.2.2 wlan0 mtu 0';

function agent({ id = 100, iface = 'wlan0', addr = '10.0.2.16/24', routes = route,
  caps = 'NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&VALIDATED' } = {}) {
  return `  NetworkAgentInfo{ ni{[type: WIFI[], state: CONNECTED/CONNECTED]} network{${id}} nethandle{432902426637} `
    + `lp{{InterfaceName: ${iface} LinkAddresses: [ ${addr} ] DnsAddresses: [ /10.0.2.3 ] Routes: [ ${routes} ]}} `
    + `nc{[ Transports: WIFI Capabilities: ${caps} LinkUpBandwidth>=100Kbps ]} everValidated{true} lastValidated{true} }`;
}

function dump(id, ...records) {
  return [`Active default network: ${id}`, 'Current Networks:', ...records].join('\n');
}

function shellFixture(commands, after = () => {}) {
  const trace = [];
  return { trace, client: { async shell(cmd, opts) {
    trace.push([cmd, opts.timeout]);
    if (!(cmd in commands)) throw new Error('unexpected shell command: ' + cmd);
    const result = typeof commands[cmd] === 'function' ? await commands[cmd]() : commands[cmd];
    after(cmd);
    return result;
  } } };
}

test('a disconnected radio address or historical validation does not show internet ready', async () => {
  const { client, trace } = shellFixture({
    [WIFI_STATUS]: DOWN,
    [SNAPSHOT_COMMAND]: dump('none', agent({ iface: 'radio0', addr: '10.0.2.15/24',
      routes: '0.0.0.0/0 -> 10.0.2.2 radio0 mtu 0' })),
  });
  const result = await checkGuestNetwork(client, { verifyInternet: true });
  assert.deepEqual(result, { ok: false, wifiConnected: false, reachable: false, reason: 'wifi-not-connected' });
  assert.ok(!trace.some(([cmd]) => cmd === REACHABILITY_CHECK));
});

test('uses only the active default network; validation on a different active agent never leaks', async () => {
  const text = dump(101, agent({ id: 100 }), agent({ id: 101, addr: '10.0.2.18/24', caps: 'INTERNET&TRUSTED' }));
  const { result } = inspectConnectivity(text, WIFI);
  assert.equal(result.networkId, 101);
  assert.equal(result.ip, '10.0.2.18');
  assert.equal(result.ok, false);
  assert.equal(result.reachable, null);
  assert.equal(result.reason, 'internet-unverified');
});

test('active and validated with its own default route returns the actual default gateway', async () => {
  const text = dump(100, agent({ routes: '::/0 -> fe80::2 wlan0 mtu 0, 0.0.0.0/0 -> 10.4.0.254 wlan0 mtu 0',
    addr: '2001:db8::16/64, 10.4.0.16/24' }));
  const { client } = shellFixture({ [WIFI_STATUS]: WIFI, [SNAPSHOT_COMMAND]: text });
  assert.deepEqual(await checkGuestNetwork(client), {
    ok: true, reason: '', wifiConnected: true, reachable: true, validated: true,
    networkId: 100, ip: '10.4.0.16', gateway: '10.4.0.254',
  });
  assert.equal(inspectConnectivity(dump(100, agent({ routes: '0.0.0.0/0 -> 10.0.2.2 dummy0 mtu 0' })), WIFI).result.reason, 'no-default-route');
  assert.equal(inspectConnectivity(dump(100, agent({ addr: '169.254.2.3/24, fe80::8/64' })), WIFI).result.reason, 'no-ip-address');
});

test('Wi-Fi disconnected does not invalidate a verified cellular or VPN default route', () => {
  const text = dump(106, agent({ id: 106, iface: 'radio0', addr: '10.0.2.15/24',
    routes: '0.0.0.0/0 -> 10.0.2.2 radio0 mtu 0' }));
  const { result } = inspectConnectivity(text, DOWN);
  assert.equal(result.ok, true);
  assert.equal(result.wifiConnected, false);
  assert.equal(result.ip, '10.0.2.15');
});

test('captive portal, partial connectivity and disabled validation are not proofs', async () => {
  for (const caps of ['INTERNET&VALIDATED&CAPTIVE_PORTAL', 'INTERNET&VALIDATED&PARTIAL_CONNECTIVITY', 'INTERNET&NOT_VALIDATED']) {
    const data = inspectConnectivity(dump(100, agent({ caps })), WIFI);
    assert.equal(data.result.ok, false);
    if (caps !== 'INTERNET&NOT_VALIDATED') assert.equal(data.probeKey, null);
  }
  const { client, trace } = shellFixture({
    [WIFI_STATUS]: WIFI.replace('=null', '=0'), [SNAPSHOT_COMMAND]: dump(100, agent()),
    [REACHABILITY_CHECK]: 'HTTP/1.1 204 No Content',
  });
  assert.equal((await checkGuestNetwork(client)).ok, false);
  assert.equal(trace.length, 2);
  const proven = await checkGuestNetwork(client, { verifyInternet: true });
  assert.equal(proven.ok, true);
  assert.equal(proven.validated, false);
  assert.equal(proven.reachable, true);
  assert.equal(trace.filter(([cmd]) => cmd === REACHABILITY_CHECK).length, 1);
  trace.length = 0;
  assert.equal(await repairStockWifi(client), true);
  assert.ok(trace.every(([cmd]) => [WIFI_STATUS, SNAPSHOT_COMMAND, REACHABILITY_CHECK].includes(cmd)));
});

test('a redirect or route change during an internet probe must not confirm readiness', async () => {
  const unvalidated = dump(100, agent({ caps: 'INTERNET' }));
  const redirect = shellFixture({
    [WIFI_STATUS]: WIFI, [SNAPSHOT_COMMAND]: unvalidated, [REACHABILITY_CHECK]: 'HTTP/1.1 302 Found',
  });
  const failed = await checkGuestNetwork(redirect.client, { verifyInternet: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.reachable, false);
  let probes = 0;
  const stale = shellFixture({
    [WIFI_STATUS]: WIFI,
    [SNAPSHOT_COMMAND]: () => ++probes === 1 ? unvalidated : dump(101, agent({ id: 101, caps: 'INTERNET' })),
    [REACHABILITY_CHECK]: 'HTTP/1.1 204 No Content',
  });
  assert.deepEqual(await checkGuestNetwork(stale.client, { verifyInternet: true }), {
    ok: false, reason: 'internet-unverified', networkId: 101, wifiConnected: true,
    reachable: null, ip: '10.0.2.16', gateway: '10.0.2.2', validated: false,
  });
});

test('checks the separate facts of transport failure, unknown probe output, and a timed wait', async () => {
  function failing(message) {
    return shellFixture({ [WIFI_STATUS]: WIFI, [SNAPSHOT_COMMAND]: () => { throw new Error(message); } }).client;
  }
  assert.equal((await checkGuestNetwork(failing("error: device 'emulator-5554' not found"))).reason, 'device-offline');
  assert.equal((await checkGuestNetwork(failing('dumpsys timed out'))).reason, 'internet-unverified');
  let clock = 0;
  const fixture = shellFixture({ [WIFI_STATUS]: DOWN, [SNAPSHOT_COMMAND]: dump('none') });
  const fail = await checkGuestNetwork(fixture.client, {
    waitMs: 21, interval: 10, now: () => clock, pause: async (n) => { clock += n; },
  });
  assert.equal(fail.reason, 'wifi-not-connected');
  assert.equal(clock, 21);
  assert.deepEqual(fixture.trace.map(([, timeout]) => timeout), [21, 21, 11, 11, 1, 1]);
});

test('the bounded repair joins only the visible open stock hotspot and verifies actual egress', async () => {
  let connected = false;
  const repair = shellFixture({
    [WIFI_STATUS]: () => connected ? WIFI : DOWN,
    [SNAPSHOT_COMMAND]: () => connected ? dump(100, agent()) : dump('none'),
    'cmd wifi list-scan-results': STOCK,
    [STOCK_WIFI_CONNECT]: () => {
      connected = true;
      return 'Connection initiated';
    },
  });
  assert.equal(await repairStockWifi(repair.client), true);
  assert.deepEqual(repair.trace.map(([cmd]) => cmd), [
    WIFI_STATUS, SNAPSHOT_COMMAND, 'cmd wifi list-scan-results', WIFI_STATUS,
    SNAPSHOT_COMMAND, STOCK_WIFI_CONNECT, WIFI_STATUS, SNAPSHOT_COMMAND,
  ]);
  assert.equal(isStockWifiVisible(STOCK), true);
  assert.equal(isStockWifiVisible(STOCK.replace('02:15:b2:00:01:00', 'de:ad:be:ef:01:00')), false);
  assert.equal(isStockWifiVisible(STOCK.replace('AndroidWifi', 'AndroidWifi-Lobby')), false);
  assert.equal(isStockWifiVisible(STOCK.replace('[ESS]', '[WPA2-PSK-CCMP][ESS]')), false);
});

test('the Android 14 stock address can be repaired without guessing an ambiguous radio', async () => {
  const bssid = '02:15:b2:00:00:01';
  const android14 = STOCK.replace('02:15:b2:00:01:00', bssid);
  const connect = STOCK_WIFI_CONNECT.replace('02:15:b2:00:01:00', bssid);
  let connected = false;
  const repair = shellFixture({
    [WIFI_STATUS]: () => connected ? WIFI : DOWN,
    [SNAPSHOT_COMMAND]: () => connected ? dump(100, agent()) : dump('none'),
    'cmd wifi list-scan-results': android14.replace(bssid, bssid.toUpperCase()),
    [connect]: () => { connected = true; return 'Connection initiated'; },
  });
  assert.equal(await repairStockWifi(repair.client), true);
  assert.deepEqual(repair.trace.map(([cmd]) => cmd).filter((cmd) => cmd.startsWith('cmd wifi connect-network')), [connect]);

  let now = 0;
  const ambiguous = shellFixture({
    [WIFI_STATUS]: DOWN, [SNAPSHOT_COMMAND]: dump('none'),
    'cmd wifi list-scan-results': `${STOCK}\n${android14}`, 'cmd wifi start-scan': '',
  });
  assert.equal(await repairStockWifi(ambiguous.client, { now: () => now, pause: async (ms) => { now += ms; } }), false);
  assert.equal(ambiguous.trace.some(([cmd]) => cmd.startsWith('cmd wifi connect-network')), false);
});

test('Wi-Fi repair stops on changed ownership and does not enable intentionally disabled Wi-Fi', async () => {
  let owned = true;
  const stale = shellFixture({
    [WIFI_STATUS]: DOWN, [SNAPSHOT_COMMAND]: dump('none'), 'cmd wifi list-scan-results': STOCK,
  }, (cmd) => { if (cmd === 'cmd wifi list-scan-results') owned = false; });
  assert.equal(await repairStockWifi(stale.client, { canMutate: async () => owned }), false);
  assert.deepEqual(stale.trace.map(([cmd]) => cmd), [WIFI_STATUS, SNAPSHOT_COMMAND, 'cmd wifi list-scan-results']);

  const disabled = shellFixture({
    [WIFI_STATUS]: 'Wifi is disabled', [SNAPSHOT_COMMAND]: dump('none'),
  });
  assert.equal(await repairStockWifi(disabled.client), false);
  assert.deepEqual(disabled.trace.map(([cmd]) => cmd), [WIFI_STATUS, SNAPSHOT_COMMAND]);
});

test('does not mistake a scan start acknowledgement or the first empty results for scan completion', async () => {
  let now = 0;
  let scans = 0;
  let connected = false;
  const fixture = shellFixture({
    [WIFI_STATUS]: () => connected ? WIFI : DOWN,
    [SNAPSHOT_COMMAND]: () => connected ? dump(100, agent()) : dump('none'),
    'cmd wifi list-scan-results': () => ++scans < 3 ? '' : STOCK,
    'cmd wifi start-scan': 'Scan initiated',
    [STOCK_WIFI_CONNECT]: () => { connected = true; return 'Connection initiated'; },
  });
  assert.equal(await repairStockWifi(fixture.client, {
    now: () => now, pause: async (ms) => { now += ms; },
  }), true);
  assert.equal(now, 2000);
  assert.equal(scans, 3);
  assert.equal(fixture.trace.filter(([cmd]) => cmd === 'cmd wifi start-scan').length, 1);
  assert.equal(fixture.trace.filter(([cmd]) => cmd === STOCK_WIFI_CONNECT).length, 1);
});

test('returns false after bounded scans if the isolated guest has no stock virtual hotspot', async () => {
  let now = 0;
  const fixture = shellFixture({
    [WIFI_STATUS]: DOWN,
    [SNAPSHOT_COMMAND]: dump('none'),
    'cmd wifi list-scan-results': 'No scan results',
    'cmd wifi start-scan': '',
  });
  assert.equal(await repairStockWifi(fixture.client, {
    now: () => now, pause: async (ms) => { now += ms; },
  }), false);
  assert.ok(now > 0 && now <= 5500);
  assert.ok(!fixture.trace.some(([cmd]) => cmd === STOCK_WIFI_CONNECT));
});
