'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createDiagnosticsPanel = function createDiagnosticsPanel({ api, $, state, toast, esc, relTime, openManualForIssue, openSettings, focusGroup, fillSettings, deployAll, refreshStatus }) {
    /** 自动检测的问题分类名（与 src/core/autodebug.js 的 CATEGORIES 对应） */
    const DEBUG_CATS = [
      { id: 'runtime', name: '运行时' },
      { id: 'device', name: '设备连接' },
      { id: 'storage', name: '存储' },
      { id: 'settings', name: '设置' },
      { id: 'network', name: '网络' },
      { id: 'logs', name: '日志' },
    ];

    let autodebugLast = null;

    function renderAutodebug(res) {
      const list = $('autodebugList');
      const txt = $('autodebugStateText');
      if (!list) return;
      autodebugLast = res || null;
      const issues = (res && res.issues) || [];
      const at = res && res.at;

      if (txt) {
        if (res && res.running) txt.textContent = '正在检测…';
        else if (!at) txt.textContent = '尚未检测';
        else if (!issues.length) txt.textContent = `上次检测 ${relTime(at)} · 一切正常`;
        else txt.textContent = `上次检测 ${relTime(at)} · ${issues.length} 项待处理`;
      }

      if (!issues.length) {
        list.innerHTML = `<div class="dbg-ok">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
          <span>没有发现影响使用的问题。运行时、adb 授权、磁盘、数据分区、快照与设置冲突都检查过了。</span>
        </div>`;
        updateCatBadges();
        return;
      }

      const byCat = new Map();
      for (const it of issues) {
        const key = it.category || 'runtime';
        if (!byCat.has(key)) byCat.set(key, []);
        byCat.get(key).push(it);
      }
      const order = DEBUG_CATS.map((c) => c.id);
      const keys = Array.from(byCat.keys()).sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });

      list.innerHTML = keys.map((key) => {
        const name = (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
        const items = byCat.get(key);
        return `<div class="dbg-group">
          <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
          ${items.map((it) => `
            <div class="dbg-item ${esc(it.severity || 'info')}">
              <span class="dbg-sev"></span>
              <div class="dbg-body">
                <div class="dbg-name">${esc(it.title || '')}</div>
                <div class="dbg-hint">${esc(it.hint || '')}</div>
                ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
              </div>
              ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">处理</button>` : ''}
              <button class="dbg-help" data-code="${esc(it.code)}" title="打开内置教程">教程</button>
            </div>`).join('')}
        </div>`;
      }).join('');

      list.querySelectorAll('.dbg-fix').forEach((b) => {
        b.addEventListener('click', () => {
          const issue = issues.find((x) => x.code === b.dataset.code);
          if (issue) fixIssue(issue);
        });
      });
      list.querySelectorAll('.dbg-help').forEach((b) => {
        b.addEventListener('click', () => {
          const issue = issues.find((x) => x.code === b.dataset.code);
          if (issue) openManualForIssue(issue, 'clicked');
        });
      });

      updateCatBadges();
    }

    /** 分类按钮上的问题角标：只在有问题的分类上显示数字 */
    function updateCatBadges() {
      const issues = (autodebugLast && autodebugLast.issues) || [];
      document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
        const cat = el.dataset.badge;
        // 自动检测的问题不一定都归属某个设置分类，只有设置类问题才在「诊断与修复」上打标
        const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
        el.hidden = n === 0;
        el.textContent = n ? String(n) : '';
        el.classList.toggle('warn', false);
      });
    }

    function bindAutodebug() {
      $('btnDiagnostics').addEventListener('click', async () => {
        try {
          const r = await api.doctorReport();
          toast({ title: '诊断报告已导出', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
        } catch (e) {
          toast({ title: '导出失败', body: e.message, type: 'error' });
        }
      });


      const btn = $('btnAutodebugRun');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = '检测中…';
          try {
            const r = await api.autodebugRun().catch(() => null);
            if (r) renderAutodebug(r);
            else toast({ title: '检测失败', body: '采集状态时出错，稍后再试一次', type: 'error' });
          } finally {
            btn.disabled = false;
            btn.textContent = old;
          }
        });
      }

      const report = $('btnAutodebugReport');
      if (report) {
        report.addEventListener('click', async () => {
          const r = await api.doctorReport().catch(() => null);
          if (r && r.ok !== false) toast({ title: '诊断报告已导出', body: '把报告发给作者可以最快定位问题', type: 'ok' });
          else toast({ title: '导出失败', body: (r && r.error) || '请重试', type: 'error' });
        });
      }

      const auto = $('setAutodebugAuto');
      if (auto) {
        auto.addEventListener('change', async () => {
          const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
          if (r) fillAutodebugSettings(r);
          toast({
            title: auto.checked ? '已开启自动检测' : '已关闭自动检测',
            body: auto.checked ? '后台会定时检查，发现新问题才提醒' : '随时可以点「立即检测」手动跑一次',
            type: 'info',
          });
        });
      }

      const interval = $('setAutodebugInterval');
      if (interval) {
        interval.addEventListener('change', async () => {
          const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
          if (r) fillAutodebugSettings(r);
          toast({ title: '检测间隔已更新', body: `每 ${r ? r.intervalMin : interval.value} 分钟检测一次`, type: 'ok' });
        });
      }

      const notify = $('setAutodebugNotify');
      if (notify) {
        notify.addEventListener('change', async () => {
          const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
          if (r) fillAutodebugSettings(r);
        });
      }
    }

    function fillAutodebugSettings(cfg) {
      if (!cfg) return;
      const auto = $('setAutodebugAuto');
      if (auto) auto.checked = cfg.auto !== false;
      const interval = $('setAutodebugInterval');
      if (interval) interval.value = String(cfg.intervalMin || 10);
      const notify = $('setAutodebugNotify');
      if (notify) notify.checked = cfg.notify !== false;
    }

    let envBusy = false;

    /** 拉取 doctor:selfCheck：把问题渲染到设置里的自检面板，并在状态条上留一个计数 */
    async function selfCheck() {
      if (envBusy) return;
      envBusy = true;
      try {
        const r = await api.selfCheck().catch(() => null);
        if (r) renderEnvCheck(r);
      } catch (_) { /* 自检失败不阻断主流程 */ }
      finally { envBusy = false; }
    }

    function renderEnvCheck(r) {
      const box = $('envCheck');
      if (!box) return;
      // 「组件缺失」在同一个面板的一键完成里已经覆盖，不再重复列出
      const needDeploy = !!(state.status && state.status.needsSetup);
      const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

      // 主界面不再放横幅：只在底部状态条上留一个可点的计数，点开就是设置里的自检面板
      const chip = $('envChip');
      if (chip) {
        const errs = issues.filter((i) => i.severity === 'error').length;
        chip.hidden = issues.length === 0;
        chip.textContent = errs ? `${errs} 项待修复` : `${issues.length} 项提示`;
        chip.className = `status-chip${errs ? ' err' : ''}`;
        chip.title = issues.map((i) => i.title).join('；');
      }

      if (!issues.length) {
        box.hidden = false;
        box.innerHTML = `
          <div class="env-check-ok">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
            <span>环境自检通过，没有发现会影响运行的问题。</span>
            <span style="flex:1"></span>
            <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
          </div>`;
        const re = $('btnEnvRecheck');
        if (re) re.addEventListener('click', selfCheck);
        return;
      }
      const errs = issues.filter((i) => i.severity === 'error').length;
      const warns = issues.length - errs;
      box.hidden = false;
      box.innerHTML = `
        <div class="env-check-head">
          <span class="ec-title">环境自检</span>
          ${errs ? `<span class="ec-count">${errs} 个严重</span>` : ''}
          ${warns ? `<span class="ec-count warn">${warns} 个提示</span>` : ''}
          <span class="ec-spacer"></span>
          <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
          <button class="btn primary sm" id="btnEnvFixAll">一键修复全部</button>
        </div>
        <div class="env-check-list">
          ${issues.map((i) => `
            <div class="env-check-item ${i.severity}">
              <span class="ec-sev"></span>
              <div class="ec-body">
                <div class="ec-name">${esc(i.title)}</div>
                <div class="ec-hint">${esc(i.hint || '')}</div>
              </div>
              ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">修复</button>` : ''}
              <button class="ec-help" data-code="${esc(i.code)}" title="打开内置教程">教程</button>
            </div>`).join('')}
        </div>`;
      const re = $('btnEnvRecheck');
      if (re) re.addEventListener('click', selfCheck);
      const fixAll = $('btnEnvFixAll');
      if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
      box.querySelectorAll('.ec-fix').forEach((b) => {
        b.addEventListener('click', () => {
          const issue = issues.find((x) => x.code === b.dataset.code);
          if (issue) fixIssue(issue);
        });
      });
      box.querySelectorAll('.ec-help').forEach((b) => {
        b.addEventListener('click', () => {
          const issue = issues.find((x) => x.code === b.dataset.code);
          if (issue) openManualForIssue(issue, 'clicked');
        });
      });
    }

    /** 修复没成功：如实报错，并把对应教程自动打开（同一章节主进程 60 秒内只弹一次） */
    function failFix(issue, ctl, body) {
      const msg = body || '请按教程手动处理';
      if (ctl && typeof ctl.update === 'function') ctl.update({ body: msg, type: 'error', sticky: true });
      else toast({ title: '修复未完成', body: msg, type: 'error' });
      openManualForIssue(issue, 'fix-failed');
    }

    async function fixIssue(issue) {
      switch (issue.fix) {
        case 'vcRedist': {
          const r = await api.installVcRedist().catch(() => ({ ok: false }));
          if (!r.ok && r.reason === 'no-installer') {
            api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
            toast({ title: '未找到内置安装包', body: '已打开微软官方下载页，请下载 x64 版本', type: 'info' });
            break;
          }
          toast(r.ok
            ? { title: 'VC++ 运行库已安装', type: 'ok' }
            : { title: '安装未完成', body: r.error || '请重试', type: 'error' });
          break;
        }
        case 'virtualization': {
          const t = toast({ title: '正在开启硬件加速…', body: '请在弹出的窗口点「是」', sticky: true, spinner: true });
          const r = await api.enableVirtualization().catch(() => ({ ok: false }));
          if (r.ok) {
            t.update({ title: '硬件加速已启用', body: r.restartNeeded ? '请重启电脑以获得最佳性能' : (r.note || ''), type: 'ok' });
            setTimeout(t.dismiss, 3200);
          } else if (r.manual) {
            // 商店（MSIX）版：包固定 mediumIL，通常拿不到管理员授权。
            // 与其让用户点一个注定失败的按钮，不如直接把「启用或关闭 Windows 功能」
            // 对话框弹出来，并告诉他勾哪一项。
            t.dismiss();
            await api.openWindowsFeatures?.().catch(() => null);
            toast({
              title: '需要手动开启一次（仅此一次）',
              body: r.note || '在打开的窗口里勾选「Windows 虚拟机监控程序平台」，确定后重启电脑。',
              type: 'info',
              sticky: true,
            });
            // 自动提权走不通时，同步把图文教程打开，避免用户对着系统窗口不知道勾哪个
            openManualForIssue(issue, 'fix-failed');
          } else if (r.cancelled) {
            t.update({ title: '已取消', body: r.error || '没有拿到管理员授权，硬件加速没有改动。', type: 'info', spinner: false });
            setTimeout(t.dismiss, 4200);
          } else {
            failFix(issue, t, r.error || r.note || '未能开启硬件加速，已打开对应教程');
          }
          break;
        }
        case 'disk': {
          // 主进程会弹出原生确认框（含可释放空间预览），这里不再重复 confirm
          const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
          if (!r || r.ok === false) { toast({ title: '清理失败', body: r?.error || '请重试', type: 'error' }); break; }
          if (r.cancelled) break;
          toast({ title: '清理完成', body: `释放约 ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
          break;
        }
        case 'path': {
          toast({ title: '建议改到纯英文目录', body: '在 设置 → 系统集成 里修改「运行时数据目录」，再重启软件。', type: 'info', sticky: true });
          openSettings();
          break;
        }
        case 'deploy': {
          toast({ title: '正在补齐缺失的运行时组件…', type: 'info', sticky: true, spinner: true });
          await deployAll();
          break;
        }
        case 'lock': {
          const r = await api.clearLocks().catch(() => ({ ok: false }));
          toast(r.ok ? { title: '可以重新启动运行时', body: r.note, type: 'info' } : { title: '当前不能处理锁', body: r.error, type: 'error' });
          break;
        }
        // ---- 自动检测（自动 debug）新增的修复动作 ----
        case 'restartRuntime': {
          // unauthorized / 引导卡死 / 孤儿锁的首选自愈动作：停一次再拉起来（走冷启动）
          const t = toast({ title: '正在重启安卓运行时…', body: '会重新引导一次，大约十几秒', type: 'info', sticky: true, spinner: true });
          const r = await api.restartRuntime().catch(() => ({ ok: false }));
          if (r && r.ok) {
            t.update({ title: '安卓运行时已重启', body: '授权弹窗请点「允许」', type: 'ok' });
            setTimeout(t.dismiss, 3000);
          } else {
            failFix(issue, t, (r && r.error) || '重启失败，已打开对应教程');
          }
          break;
        }
        case 'orphans': {
          const r = await api.clearOrphans().catch(() => ({ ok: false }));
          toast(r && r.ok
            ? { title: 'ApkStart 安卓运行时未在运行', body: r.note, type: 'ok' }
            : { title: '清理失败', body: (r && r.error) || '请重试', type: 'error' });
          break;
        }
        case 'snapshots': {
          const r = await api.clearSnapshot().catch(() => ({ ok: false }));
          toast(r && r.ok
            ? { title: '已作废快速启动快照', body: '下次打开应用会走一次完整冷启动', type: 'ok' }
            : { title: '作废失败', body: (r && r.error) || '请重试', type: 'error' });
          break;
        }
        case 'dataReset': {
          // 扩容被差量盘挡住时必须重建：会清掉已装应用，所以只引导、不自动做。
          toast({
            title: '需要重建安卓数据分区',
            body: '到「设置 → 性能与资源」点「立即扩容」；提示需要重置时确认一次（会清空已装应用）。',
            type: 'info',
            sticky: true,
          });
          openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
          break;
        }
        case 'orientation': {
          // 让物理面板方向跟上策略：策略要横屏就切横屏，要竖屏就切竖屏
          const s = (state.settings && state.settings.display) || {};
          const mode = s.orientationMode || 'auto';
          if (mode === 'auto') {
            toast({ title: '当前是「跟随应用」', body: '面板方向会按应用自动切换；若某个应用方向不对，可对它单独指定。', type: 'info' });
            break;
          }
          const wantLandscape = mode === 'landscape';
          state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
          fillSettings(state.settings);
          toast({
            title: wantLandscape ? '面板已切成横屏' : '面板已切成竖屏',
            body: '下次打开应用生效',
            type: 'ok',
          });
          break;
        }
        case 'shared': {
          toast({ title: '请检查共享目录', body: '到「设置 → 集成与文件」确认本机共享目录存在且可写。', type: 'info', sticky: true });
          openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
          break;
        }
        // ---- 0.6.2 声音检测对应的修复动作 ----
        case 'audio': {
          const t = toast({ title: '正在打开安卓应用声音…', body: '重启安卓运行时后恢复播放', type: 'info', sticky: true, spinner: true });
          const s = await api.setSettings({ engine: { audio: true } }).catch(() => null);
          if (!s) { failFix(issue, t, '没能保存声音设置，已打开对应教程'); break; }
          state.settings = s;
          fillSettings(s);
          const r = await api.restartRuntime().catch(() => ({ ok: false }));
          if (r && r.ok !== false) {
            t.update({ title: '声音已打开', body: '运行时已重启，现在应该能听到应用声音了', type: 'ok' });
            setTimeout(t.dismiss, 3600);
          } else {
            failFix(issue, t, '声音开关已打开，但运行时重启失败，已打开对应教程');
          }
          break;
        }
        case 'audioService': {
          // MSIX / 普通权限都拿不到系统服务的提权操作，直接把教程送到用户面前
          toast({ title: '需要手动启动 Windows Audio', body: '已打开教程，照着做一次即可', type: 'info', sticky: true });
          openManualForIssue(issue, 'clicked');
          break;
        }
        case 'repairNetwork': {
          const t = toast({ title: '正在修复安卓网络…', body: '可能重启安卓，不会清除数据', type: 'info', sticky: true, spinner: true });
          const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
          if (r && r.ok !== false) {
            t.update({ title: '安卓网络已恢复', body: '安卓数据未清除', type: 'ok' });
            setTimeout(t.dismiss, 3000);
          } else {
            t.update({ title: '修复失败', body: (r && r.error) || '请重试', type: 'error' });
          }
          break;
        }
        case 'report': {
          const r = await api.doctorReport().catch(() => null);
          toast(r && r.ok !== false
            ? { title: '诊断报告已导出', body: '把报告发给作者可以最快定位问题', type: 'ok' }
            : { title: '导出失败', body: (r && r.error) || '请重试', type: 'error' });
          break;
        }
        case 'settings': {
          openSettings();
          break;
        }
        default:
          toast({ title: '暂不支持自动修复', body: issue.hint || '', type: 'info' });
      }
      // 修复后重新自检，刷新横幅与状态
      setTimeout(selfCheck, 600);
      setTimeout(refreshStatus, 600);
    }

    async function fixAllIssues(issues) {
      const fixable = issues.filter((i) => i.fix);
      for (const i of fixable) {
        // eslint-disable-next-line no-await-in-loop
        await fixIssue(i);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 500));
      }
    }

    return { bind: bindAutodebug, selfCheck, render: renderAutodebug, fillPreferences: fillAutodebugSettings, updateBadges: updateCatBadges };
  };
})();
