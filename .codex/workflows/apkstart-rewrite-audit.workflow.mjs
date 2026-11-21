export const meta = {
  name: 'apkstart-rewrite-audit',
  description: 'Derive the compatibility and reliability contract for a staged rewrite of ApkStart.',
  phases: [{ title: '沿代码核实现状' }, { title: '交叉审查迁移边界' }],
};
const areas = [
  ['runtime', 'Runtime backends, QEMU/Android Emulator lifecycle, owned vs external runtime, ADB target isolation, boot/retry/timeout, orientation restart. Focus src/core/backends, adb.js, engine.js, emulator.js, android.js.'],
  ['install', 'APK parsing/install, launch intent, public CLI and host shortcut/association, manifest/icon fallbacks, failure semantics. Focus src/core/apk.js, installer.js, apk.js consumers in src/main.js, shortcut.js, assoc.js; track existing tests.'],
  ['state', 'Persistent config, app catalogue, downloads/updater, offline/online runtime provisioning, state migrations, paths/data loss and rollback. Focus store.js, userdata.js, provision.js, download.js, updater.js.'],
  ['platform', 'Windows support and release/CI (including Windows paths, Unicode, x64, engine acceleration, app window behavior, MSIX and portable). Include user intent: mic/headphone passthrough and local App smoke test, without promising it works. Focus src/core/appwin.js, windowctl.js, src/core/win, build, .github; note Linux support claims versus evidence.'],
  ['tests', 'Current tests, Electron IPC/context boundary and major seams, safest real-machine vs hermetic regression matrix. Focus src/main.js, src/preload.js, package.json, test, CI.'],
];
const strings = { type: 'array', items: { type: 'string' } };
const findings = {
  type: 'object',
  properties: { contracts: strings, risks: strings, tests: strings, firstSlice: { type: 'string' } },
  required: ['contracts', 'risks', 'tests', 'firstSlice'],
  additionalProperties: false,
};
const synthesis = {
  type: 'object',
  properties: { compatibleCore: strings, pendingDecisions: strings, migrationOrder: strings, acceptanceGates: strings },
  required: ['compatibleCore', 'pendingDecisions', 'migrationOrder', 'acceptanceGates'],
  additionalProperties: false,
};
phase('沿代码核实现状');
log('Five source-backed tracks at ' + args.base);
const reports = await parallel(areas.map(([key, scope]) => () =>
  agent(`Read-only characterization of public ApkStart at ${args.base}. Use git show <base>:path or pinned source; the working tree may gain new code during this run. Scope: ${scope} Return 3–6 concise findings per array, each with file:symbol evidence. Separate documented intention, source-observed behavior, and machine paths not tested. Identify one well-bounded first rewrite slice. No writes, installs, releases, namespace changes, app data access, or runtime startup.`,
    { label: key, phase: '沿代码核实现状', schema: findings })));
const usable = reports.map((report, i) => ({ area: areas[i][0], report })).filter(x => x.report);
log(usable.length + '/' + areas.length + ' tracks returned; preparing global migration review');
phase('交叉审查迁移边界');
const contract = usable.length
  ? await agent(`Review this pinned-baseline inventory as an independent compatibility reviewer: ${JSON.stringify(usable)}. Propose a staged from-scratch core with an adapter seam, data migration and rollback, explicit side effects, and concrete gates. Preserve proven public behavior without preserving failure modes. Flag missing evidence, do not claim tests ran. Read-only. No releases or writes.`,
    { label: 'migration-review', phase: '交叉审查迁移边界', schema: synthesis })
  : null;
return { base: args.base, tracks: usable, contract };
