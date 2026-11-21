export const meta = {
  name: 'apkstart-architecture',
  description: 'Cross-check the architectural proposal against the pinned source and turn its risks into regression gates.',
  phases: [{ title: '对照当前代码' }, { title: '交叉审查' }],
};
const report = {
  type: 'object',
  properties: {
    findings: {type: 'array', items: {type: 'string'}},
    gates: {type: 'array', items: {type: 'string'}},
  },
  required: ['findings', 'gates'],
  additionalProperties: false,
};
const tracks = [
  ['lifecycle', 'Verify present-day VM boot/stop/repanel and app-session state ownership with git show. Look for interleavings crossing lifecycle boundaries, typed queue failure handling, late window close, and useful offline replay cases. Check the claim adb track-app can replace process observation.'],
  ['ipc', 'Verify lifecycle/registration/IPC coupling, renderer preload contract and source-shape tests. Recommend testable separation that preserves public IPC, session/VM boundaries, native confirmations, Electron window timing and existing literal responses. Reject line counts as substitutes for behavior.'],
  ['downloads', 'Defensive audit only: verify current archive checksum and elevated AEHD install chain. Use trusted primary metadata only. Check whether 2 GB data partition and dual AVD/shared read-only image claims guarantee disk and orientation performance. No installer downloads/execution, no device/machine changes.'],
];
const base = args?.base || '349acdc83483da739cb3293fefdc0cff220ab456';
phase('对照当前代码');
log('Pinned ApkStart baseline ' + base);
const reviews = await parallel(tracks.map(([label, scope]) => () => agent(
  'Read-only review at repository commit ' + base + ' in the current folder; use git show to avoid work-in-progress changes. ' + scope
  + ' Return verified code locations, any uncertainty and exact acceptance cases. No edits, destructive operations, GUI launches or writes.',
  {label, phase: '对照当前代码', schema: report, webSearch: label === 'downloads' || label === 'lifecycle'},
)));
phase('交叉审查');
const valid = reviews.filter(Boolean);
log(valid.length + ' independent reports; cross-checking claims and regression gates');
const synthesis = valid.length ? await agent(
  'Read-only independent cross-check of these ApkStart reviews. Separate verified architectural risk from unproved recommendations and future benchmarks. Prioritize runnable regression gates for IPC split, session lifecycle and a single VM command queue. Do not modify files. ' + JSON.stringify(valid),
  {label: 'review-gate', phase: '交叉审查', schema: report},
) : null;
return {base, reviews, synthesis};
