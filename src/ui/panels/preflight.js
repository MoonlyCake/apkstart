'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createPreflightPanel = function createPreflightPanel({ api, $, toast, applySettings, refreshStatus }) {
    /** 本机体检：渲染报告（每条带等级点和可执行动作） */
    function renderPreflight(res) {
      const list = $('preflightList');
      const sum = $('preflightSummary');
      const applyBtn = $('btnPreflightApply');
      if (!list) return;
      list.textContent = '';
      if (!res || !res.report) {
        if (sum) sum.textContent = (res && res.error) || '体检没有返回结果，请重试';
        return;
      }
      const { report, edition } = res;
      for (const it of report.items) {
        const item = document.createElement('div');
        item.className = 'pf-item';
        const head = document.createElement('div');
        head.className = 'pf-head';
        const dot = document.createElement('span');
        dot.className = `pf-dot ${it.level}`;
        const title = document.createElement('span');
        title.className = 'pf-title';
        title.textContent = it.title;
        head.append(dot, title);
        item.append(head);
        if (it.detail) {
          const d = document.createElement('div');
          d.className = 'pf-detail';
          d.textContent = it.detail;
          item.append(d);
        }
        if (it.action && it.action.kind === 'elevate') {
          const wrap = document.createElement('div');
          wrap.className = 'pf-action';
          const btn = document.createElement('button');
          btn.className = 'btn ghost sm';
          btn.textContent = it.action.label;
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = '正在处理…';
            let r = null;
            if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
            else r = await api.enableVirtualization().catch(() => null);
            btn.disabled = false;
            btn.textContent = old;
            if (!r) { toast({ type: 'error', title: '操作没有完成', body: '可以稍后重试，或手动按提示操作' }); return; }
            if (r.cancelled) toast({ type: 'warn', title: '已取消', body: '没有修改系统设置' });
            else if (r.ok || r.already) {
              const reboot = r.restartNeeded === true;
              toast({
                type: 'ok',
                title: r.already ? '硬件加速已经可用' : (reboot ? '已提交，需要重启' : '已生效'),
                body: r.already ? '' : (reboot ? '重启电脑后硬件加速才会生效，回来点「开始体检」确认' : '可以点「开始体检」确认结果'),
              });
              if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
            } else {
              toast({ type: 'error', title: '没能自动完成', body: (r.error || r.note || '请按提示手动操作') });
            }
          });
          wrap.append(btn);
          item.append(wrap);
        } else if (it.action && it.action.kind === 'manual') {
          const wrap = document.createElement('div');
          wrap.className = 'pf-action pf-detail';
          wrap.textContent = `⚠ ${it.action.label}`;
          item.append(wrap);
        }
        list.append(item);
      }
      const rec = report.recommended || {};
      if (sum) {
        sum.textContent = `${report.summary}。推荐配置：${Math.round((rec.memoryMB || 0) / 1024)} GB 内存 / `
          + `${rec.cores || 2} 核 / ${rec.renderSize || 'auto'} · 渲染 ${rec.gpuMode || 'auto'}`
          + (edition === 'store' ? '（商店版：系统功能只能在「Windows 功能」里手动开）' : '');
      }
      if (applyBtn) applyBtn.hidden = false;
    }

    async function runPreflight() {
      const btn = $('btnPreflight');
      const sum = $('preflightSummary');
      if (!btn) return null;
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '体检中…';
      if (sum) sum.textContent = '正在检查虚拟化、显卡、内存…（第一次约 2~3 秒）';
      let r = null;
      try {
        r = await api.preflightRun();
      } catch (e) {
        r = { error: e.message || '体检失败' };
      }
      btn.disabled = false;
      btn.textContent = old;
      renderPreflight(r);
      return r;
    }

    /** 驱动（兼容补丁）：渲染清单 + 命中状态 */
    function renderDrivers(r) {
      const list = $('drvList');
      const sum = $('drvSummary');
      if (!list) return;
      const host = (r && r.host) || {};
      const drivers = (r && r.drivers) || [];
      const errors = (r && r.errors) || [];
      const onCount = drivers.filter((d) => d.enabled && d.matched).length;
      if (sum) {
        const accel = host.accel === 'none' ? '无硬件加速' : (host.accel || '未知');
        sum.textContent = `本机：${host.platform || ''}/${host.arch || ''} · ${host.gpuVendor || '未知'} 显卡 · ${accel}`
          + ` · emulator ${host.emulatorVersion || '未知'}；驱动 ${drivers.length} 个，本机已生效 ${onCount} 个。`
          + (errors.length ? ` ${errors.length} 个文件加载失败（见下）。` : '');
      }
      list.textContent = '';
      for (const d of drivers) {
        const item = document.createElement('div');
        item.className = d.enabled ? 'drv-item on' : 'drv-item';

        const head = document.createElement('div');
        head.className = 'drv-head';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!d.enabled;
        cb.addEventListener('change', async () => {
          const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
          if (res && res.ok && res.overview) renderDrivers(res.overview);
          else { cb.checked = !cb.checked; toast({ type: 'error', title: '保存失败', body: (res && res.error) || '请稍后再试' }); }
        });
        const name = document.createElement('span');
        name.className = 'drv-name';
        name.textContent = d.name;
        head.append(cb, name);

        if (d.matched && d.enabled) {
          const b = document.createElement('span');
          b.className = 'drv-badge hit';
          b.textContent = '已生效';
          head.append(b);
        }
        if (d.builtin) {
          const b = document.createElement('span');
          b.className = 'drv-badge';
          b.textContent = '内置示例';
          head.append(b);
        }
        item.append(head);

        const meta = document.createElement('div');
        meta.className = 'drv-meta';
        meta.textContent = `v${d.version || '?'}`
          + (d.author ? ` · ${d.author}` : '')
          + ` · priority ${d.priority}`
          + (d.hits && d.hits.length ? ` · 命中：${d.hits.join(' / ')}` : ' · 本机不匹配');
        item.append(meta);

        if (d.description) {
          const desc = document.createElement('div');
          desc.className = 'drv-meta';
          desc.textContent = d.description;
          item.append(desc);
        }
        list.append(item);
      }
      for (const e of errors) {
        const err = document.createElement('div');
        err.className = 'drv-err';
        err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
        list.append(err);
      }
      if (!drivers.length && !errors.length) {
        const empty = document.createElement('div');
        empty.className = 'drv-meta';
        empty.textContent = '还没有任何驱动。可以点「导出本机模板」做一个，或导入别人做好的 JSON。';
        list.append(empty);
      }
    }

    async function refreshDrivers() {
      if (!$('drvList')) return;
      const r = await api.driversList().catch(() => null);
      if (!r) {
        if ($('drvSummary')) $('drvSummary').textContent = '读不到驱动列表（运行时可能还没部署）';
        return;
      }
      renderDrivers(r);
    }

    function bind() {
      if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
      if ($('btnPreflightApply')) {
        $('btnPreflightApply').addEventListener('click', async () => {
          const btn = $('btnPreflightApply');
          btn.disabled = true;
          const r = await api.preflightApply().catch(() => null);
          btn.disabled = false;
          if (!r || !r.ok) {
            toast({ type: 'error', title: '应用失败', body: (r && r.error) || '请稍后再试' });
            return;
          }
          toast({
            type: 'ok',
            title: '已按这台机器配置好',
            body: `内存 ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} 核 / ${r.recommended.renderSize}`
              + (r.driverFile ? '；已生成驱动，下次开机会自动套用' : ''),
          });
          if (r.driverError) toast({ type: 'warn', title: '驱动没写成功', body: r.driverError });
          applySettings(r.settings);
          refreshDrivers();
          refreshStatus();
        });
      }
      if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
      if ($('btnDrvFolder')) {
        $('btnDrvFolder').addEventListener('click', async () => {
          const r = await api.driversOpenFolder().catch(() => null);
          if (!r || !r.ok) toast({ type: 'error', title: '打不开驱动目录' });
        });
      }
      if ($('btnDrvImport')) {
        $('btnDrvImport').addEventListener('click', async () => {
          const r = await api.driversImport().catch(() => null);
          if (!r || r.canceled) return;
          if (!r.ok) {
            toast({ type: 'error', title: '导入失败', body: (r.errors || []).slice(0, 3).join('；') });
            return;
          }
          toast({ type: 'ok', title: '驱动已导入并启用', body: `${r.driver.name} v${r.driver.version}` });
          if (r.overview) renderDrivers(r.overview);
        });
      }
      if ($('btnDrvExport')) {
        $('btnDrvExport').addEventListener('click', async () => {
          const r = await api.driversExportTemplate().catch(() => null);
          if (!r || r.canceled) return;
          if (!r.ok) { toast({ type: 'error', title: '导出失败' }); return; }
          toast({ type: 'ok', title: '模板已导出', body: '改完 effect 后放到驱动目录，点「刷新」即可生效' });
          refreshDrivers();
        });
      }
    }

    return { bind, refreshDrivers };
  };
})();
