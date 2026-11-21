'use strict';

/** .apk 关联候选和 Windows 实际默认处理器是两件事，只操作 HKCU。 */
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
const STORE = 'HKCU\\Software\\ApkStart';
const CAPABILITIES_PATH = 'Software\\ApkStart\\Capabilities';
const CAPABILITIES = 'HKCU\\' + CAPABILITIES_PATH;
const REGISTERED_APPS = 'HKCU\\Software\\RegisteredApplications';
const APP_NAME = 'Apk Start --Q';
const DEFAULT_APPS_URI = 'ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent(APP_NAME);
const SETTINGS_URI = 'ms-settings:defaultapps';
const CMD_KEY = CLASSES + '\\' + PROGID + '\\shell\\open\\command';
const EXT_KEY = CLASSES + '\\' + EXT;
const OPEN_WITH_KEY = EXT_KEY + '\\OpenWithProgids';
const CHOICE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.apk\\UserChoice';
const PREV_VALUE = 'assocPrev';

const equal = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const launchCommand = (exe, args) => '"' + exe + '" ' + (args ? args + ' ' : '') + '"%1"';
const run = promisify(execFile);

function createWindowsBackend({ executeFile = run } = {}) {
  const system = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pwsh = path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const options = { windowsHide: true, encoding: 'utf8', timeout: 8000 };
  const execute = async (ps) => {
    const script = "$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" + ps;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await executeFile(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
    return JSON.parse(stdout.trim());
  };
  function registry(actions) {
    // 用 .NET Unicode 读取写回值；reg.exe 的重定向输出受宿主代码页影响，
    // 会令中文目录或显示名称在某些 Windows 上错误地通过/未通过比对。
    const data = Buffer.from(JSON.stringify(actions), 'utf8').toString('base64');
    return execute([
      "$actions=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + data + "')) | ConvertFrom-Json",
      '$hkcu=[Microsoft.Win32.Registry]::CurrentUser',
      'foreach($a in $actions){',
      "  if(!$a.key.StartsWith('HKCU\\')){throw 'Invalid registry scope'}",
      '  $key=$a.key.Substring(5); $name=[string]$a.name',
      '  if($a.op -eq "write"){',
      '    $k=$hkcu.CreateSubKey($key)',
      '    try {',
      "      if($a.type -eq 'REG_NONE'){$k.SetValue($name,[byte[]]::new(0),[Microsoft.Win32.RegistryValueKind]::None)}",
      '      else {$k.SetValue($name,[string]$a.value,[Microsoft.Win32.RegistryValueKind]::String)}',
      '      $kind=$k.GetValueKind($name); $v=$k.GetValue($name)',
      "      if(($a.type -eq 'REG_NONE' -and $kind -ne 'None') -or ($a.type -eq 'REG_SZ' -and ($kind -ne 'String' -or $v -cne $a.value))){throw 'Could not verify value'}",
      '    } finally {$k.Dispose()}',
      '  } elseif($a.op -eq "delete"){',
      '    $k=$hkcu.OpenSubKey($key,$true)',
      '    if($k){try {$k.DeleteValue($name,$false)}finally {$k.Dispose()}}',
      '  } else {',
      '    $k=$hkcu.OpenSubKey($key)',
      "    if(!$k){[Console]::Write('null');return}",
      '    try {',
      '      $value=$k.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
      "      if($null -eq $value){[Console]::Write('null');return}",
      '      $kind=$k.GetValueKind($name)',
      "      $type=switch([string]$kind){'None'{'REG_NONE'} 'String'{'REG_SZ'} default{'OTHER'}}",
      "      if($kind -eq 'None'){$value=''}",
      '      [pscustomobject]@{type=$type;value=$value} | ConvertTo-Json -Compress',
      '      return',
      '    } finally {$k.Dispose()}',
      '  }',
      '}',
      "[Console]::Write('true')",
    ].join('\n'));
  }
  const read = (key, name) => registry([{ op: 'read', key, name }]);
  const write = (key, name, value, type) => registry([{ op: 'write', key, name, value, type }]);
  const writeMany = (entries) => registry(entries.map(([key, name, value, type = 'REG_SZ']) => ({
    op: 'write', key, name, value, type,
  })));
  const remove = (key, name) => registry([{ op: 'delete', key, name }]);
  async function resolve({ refresh = false } = {}) {
    // 不运行默认关联的程序。由 Shell 读取包含 UserChoice 的实际路径与命令。
    const ps = [
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Text;',
      'using System.Runtime.InteropServices;',
      'public static class ApkAssociation {',
      '  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int e,int f,IntPtr a,IntPtr b);',
      '  [DllImport("shlwapi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int AssocQueryStringW(uint flags,uint kind,string ext,string verb,StringBuilder s,ref uint n);',
      '  public static string Resolve(uint kind) { uint n=32768; var s=new StringBuilder((int)n);',
      '    return AssocQueryStringW(0,kind,".apk","open",s,ref n)==0 ? s.ToString() : null; }',
      '}',
      "'@",
      refresh ? '[ApkAssociation]::SHChangeNotify(0x08000000,0x2000,[IntPtr]::Zero,[IntPtr]::Zero)' : '',
      '[pscustomobject]@{exe=[ApkAssociation]::Resolve(2);command=[ApkAssociation]::Resolve(1)} | ConvertTo-Json -Compress',
    ].join('\n');
    const state = await execute(ps);
    if (!state || !Object.hasOwn(state, 'exe') || !Object.hasOwn(state, 'command')) throw new Error('无法读取 Windows 默认应用');
    return state;
  }
  const isExecutable = (file) => path.win32.isAbsolute(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  return { read, write, writeMany, remove, resolve, isExecutable };
}

function createAssociationService(backend, { platform = process.platform } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  };
  const unsupported = () => ({ ok: false, registered: false, effective: false, error: '仅 Windows 支持 .apk 文件关联' });
  const get = async (key, name = '') => (await backend.read(key, name))?.value ?? null;
  const matches = (state, exe, command) => equal(state.exe, exe) && equal(state.command, command);
  const fail = (operation, error, extra = {}) => ({
    ok: false, code: 'ASSOCIATION_FAILED',
    error: operation + '：' + (error.killed ? '查询 Windows 超时' : error.cmd ? 'Windows 未能读取或写入该项设置' : error.message),
    ...extra,
  });
  const needSelection = (uri, error) => ({ needsDefaultSelection: true, settingsUri: uri, ...(error ? { error } : {}) });

  async function inspect(exe, extraArgs = '', refresh = false) {
    const expected = launchCommand(exe, extraArgs);
    const [bound, state] = await Promise.all([get(CMD_KEY), backend.resolve({ refresh })]);
    const registered = equal(bound, expected);
    const effective = matches(state, exe, expected) && (typeof backend.isExecutable !== 'function' || await backend.isExecutable(exe));
    return { ok: true, registered, effective, ...(registered && !effective ? needSelection(DEFAULT_APPS_URI) : {}) };
  }

  // 写后读取，拒绝把执行失败或无效果的写入当已成功。
  async function put(key, name, value, type = 'REG_SZ') {
    await backend.write(key, name, value, type);
    const saved = await backend.read(key, name);
    if (!saved || saved.type !== type || (type !== 'REG_NONE' && saved.value !== value)) {
      throw new Error('未能验证关联设置的写入 (' + key + ')');
    }
  }

  async function drop(key, name = '', precondition = () => true) {
    const prior = await backend.read(key, name);
    if (!prior || !precondition(prior.value)) return;
    await backend.remove(key, name);
    if (await backend.read(key, name)) throw new Error('未能验证关联设置的移除 (' + key + ')');
  }

  function associationStatus(exe, extraArgs) {
    return serial(async () => {
      if (platform !== 'win32') return unsupported();
      try { return await inspect(exe, extraArgs); }
      catch (error) { return fail('无法确认当前 .apk 打开方式', error, { registered: false, effective: false }); }
    });
  }

  function registerAssociation(exe, iconPath, extraArgs) {
    return serial(async () => {
      if (platform !== 'win32') return unsupported();
      if (typeof exe !== 'string' || !exe) return fail('关联未完成', new Error('缺少启动程序路径'));
      let previous = '';
      try {
        if (backend.isExecutable && !await backend.isExecutable(exe)) throw new Error('启动程序不存在');
        const [fallback, choice] = await Promise.all([get(EXT_KEY), get(CHOICE_KEY, 'ProgId')]);
        previous = fallback && !equal(fallback, PROGID) ? fallback : (await get(STORE, PREV_VALUE) || '');
        const command = launchCommand(exe, extraArgs);
        const icon = '"' + (iconPath || exe) + '",0';
        // 先注册自己的启动命令及 Windows 默认应用候选；最后才更新没有 UserChoice 的旧版回退项。
        const candidate = [
          [CLASSES + '\\' + PROGID, '', 'Android 应用包'],
          [CLASSES + '\\' + PROGID, 'FriendlyTypeName', 'Android 应用包'],
          [CLASSES + '\\' + PROGID + '\\DefaultIcon', '', icon],
          [CLASSES + '\\' + PROGID + '\\shell\\open', '', '安装到 ApkStart'],
          [OPEN_WITH_KEY, PROGID, '', 'REG_NONE'],
          [CAPABILITIES, 'ApplicationName', APP_NAME],
          [CAPABILITIES, 'ApplicationDescription', '在 Windows 上安装和运行 Android APK 应用'],
          [CAPABILITIES, 'ApplicationIcon', icon],
          [CAPABILITIES + '\\FileAssociations', EXT, PROGID],
          [REGISTERED_APPS, APP_NAME, CAPABILITIES_PATH],
          [CMD_KEY, '', command],
        ];
        if (backend.writeMany) await backend.writeMany(candidate);
        else for (const values of candidate) await put(...values);
        if (!choice && !await get(CHOICE_KEY, 'ProgId') && !equal(fallback, PROGID) && equal(fallback ?? '', await get(EXT_KEY) ?? '')) {
          if (fallback) await put(STORE, PREV_VALUE, fallback);
          else await drop(STORE, PREV_VALUE);
          await put(EXT_KEY, '', PROGID);
        }
        const state = await inspect(exe, extraArgs, true);
        return { ...state, ok: state.effective && state.registered, progId: PROGID, previous,
          ...(state.effective ? {} : needSelection(DEFAULT_APPS_URI, '.apk 尚未实际切换。请在 Windows 默认应用中选择 Apk Start --Q。')) };
      } catch (error) {
        return fail('无法完成 .apk 关联', error, { registered: false, effective: false });
      }
    });
  }

  function unregisterAssociation(exe, extraArgs) {
    return serial(async () => {
      if (platform !== 'win32') return unsupported();
      if (typeof exe !== 'string' || !exe) return fail('无法取消 .apk 关联', new Error('缺少当前安装的启动程序路径'));
      try {
        const expected = launchCommand(exe, extraArgs);
        if (!equal(await get(CMD_KEY), expected)) return { ok: true, removed: false, skipped: true, restored: '' };
        // 与新安装共用一个 ProgID，因此只能移除仍指向自己的命令。
        const stillOwns = async () => {
          if (!equal(await get(CMD_KEY), expected)) throw new Error('关联已由另一个 Apk Start 安装接管');
        };
        const choice = await get(CHOICE_KEY, 'ProgId');
        if (choice && (equal(choice, PROGID) || matches(await backend.resolve(), exe, expected))) {
          return { ok: false, removed: false,
            ...needSelection(SETTINGS_URI, 'Windows 当前明确选择了 Apk Start。请先在默认应用中为 .apk 选择其他应用，再取消。') };
        }
        let restored = '';
        const previous = await get(STORE, PREV_VALUE);
        await stillOwns();
        if (equal(await get(EXT_KEY), PROGID)) {
          if (previous && !equal(previous, PROGID)) {
            await put(EXT_KEY, '', previous);
            restored = previous;
          } else {
            await drop(EXT_KEY, '', (v) => equal(v, PROGID));
          }
        }
        await stillOwns();
        // 清理我们声明的值，不递归删除注册表子树，也不动 UserChoice。
        if (equal(await get(CAPABILITIES + '\\FileAssociations', EXT), PROGID)) {
          await drop(REGISTERED_APPS, APP_NAME, (v) => equal(v, CAPABILITIES_PATH));
          await drop(CAPABILITIES + '\\FileAssociations', EXT, (v) => equal(v, PROGID));
        }
        await drop(OPEN_WITH_KEY, PROGID);
        await drop(STORE, PREV_VALUE);
        await drop(CMD_KEY, '', (v) => equal(v, expected));
        const state = await inspect(exe, extraArgs, true);
        if (state.effective || state.registered) {
          return { ...state, ok: false, removed: false, restored,
            ...needSelection(SETTINGS_URI, 'Windows 仍使用这份 Apk Start 打开 .apk，请在默认应用中更换。') };
        }
        return { ok: true, removed: true, restored };
      } catch (error) {
        return fail('无法确认 .apk 关联已取消', error, { removed: false });
      }
    });
  }

  return { associationStatus, registerAssociation, unregisterAssociation };
}

module.exports = {
  ...createAssociationService(createWindowsBackend()),
  createAssociationService, createWindowsBackend, PROGID, DEFAULT_APPS_URI, SETTINGS_URI,
};
