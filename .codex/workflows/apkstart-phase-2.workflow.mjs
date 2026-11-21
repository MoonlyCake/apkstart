export const meta = {
  name: 'apkstart-phase-2',
  description: 'Audit phase-2 runtime ownership, Windows audio, staging, and performance assumptions against a pinned baseline.',
  phases: [{ title: '第二阶段基线' }, { title: '集成门槛' }],
};
const issues = { type: 'object', properties: { findings: {type:'array',items:{type:'string'}}, checks: {type:'array',items:{type:'string'}} }, required:['findings','checks'], additionalProperties:false };
const areas = [
  ['ownership', 'Trace emulator start/reuse/adoption/stop/lock cleanup. Identify a testable proof of ownership that avoids modifying external emulators or killing unknown processes. Focus engine and emulator.'],
  ['win-input', 'Trace AVD audio input/output, CLI arguments, renderer/IPC settings, hardware fallback, snapshots and app permissions. Confirm the reversible opt-in and exact limits: Windows microphones are audio routed, not USB passthrough; no automatic privacy changes. Check official sources when appropriate.'],
  ['staging', 'Trace split package staging lifetime, cleanup, IPC concurrency and cache isolation. Identify a safe narrow performance improvement and files/tests used as evidence.'],
  ['performance', 'Find bounded performance hardening without weakening correct boot/readiness or degrading UI; include measurement and Windows fixtures. Keep claims tied to source and tests.'],
];
phase('第二阶段基线');
log('Audit starts from ' + args.base);
const audits = await parallel(areas.map(([name, scope]) => () => agent('Read-only audit of public ApkStart at '+args.base+'. Use git show for captured baseline, not files being edited in parallel. ' + scope + ' Give concrete file:function findings and checks. No network uploads, deploys, application startup, or writes.', {label:name,phase:'第二阶段基线',schema:issues,webSearch:name==='win-input'})));
const reports=audits.map((report,i)=>({area:areas[i][0],report})).filter(x=>x.report);
phase('集成门槛');
log(reports.length + ' audit tracks returned; comparing gates');
const gate=reports.length===areas.length ? await agent('Cross-check these findings for phase 2 integration. Prioritize privacy, protecting other emulators, Windows fixtures, and claims that remain unproven without real mic play/recording. Read-only. ' + JSON.stringify(reports),{label:'cross-check',phase:'集成门槛',schema:issues}) : null;
return {base:args.base,reports,gate};
