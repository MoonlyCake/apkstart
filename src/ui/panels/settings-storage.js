'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createStorageSettings = function createStorageSettings({
    api, $, save, toast, refreshStatus = async () => {}, networkExplanation = () => '仍未确认可访问互联网。',
  }) {
    /** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
    async function refreshDataInfo() {
      const el = $('dataNote');
      if (!el) return;
      const info = await api.dataInfo().catch(() => null);
      if (!info) { el.textContent = '读取数据分区信息失败'; return; }
      const auto = Number(($('setDataGB') || {}).value || 0) === 0;
      // 有 quickboot 差量盘时底座镜像的大小不等于 guest 看到的容量（实测 8GB 镜像、guest 5.7GB），
      // 与其显示一个会误导人的数字，不如明确说「以运行时为准」。
      const img = info.overlay
        ? '快速启动差量盘（实际容量以运行时 /data 为准）'
        : (info.fsGB ? `实际文件系统 ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : '尚未创建'));
      const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : '未知';
      const pending = Number(info.pendingGB) > 0
        ? ` 目标 ${info.configuredGB} GB 还没生效：安卓正在用快速启动差量盘，需要「重置安卓数据」后按新容量重建（会清空已装应用）。`
        : '';
      const conflict = info.avdDirConflict
        ? ` 为保留已有数据，当前仍使用 ${info.avdDirConflict.current}；设置的 ${info.avdDirConflict.requested} 尚未接管。`
        : '';
      el.textContent = `当前数据分区：${img}${auto ? '（自动）' : ''} · 所在磁盘剩余 ${free}。${pending}`
        + conflict + ' 游戏提示「存储空间不足」时可点「立即扩容」；能就地扩容时不丢已装应用。';
    }

    function bindPartition() {
      if ($('setDataGB')) {
        $('setDataGB').addEventListener('change', (e) => {
          save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
          refreshDataInfo();
        });
      }
      if ($('btnGrowData')) {
        $('btnGrowData').addEventListener('click', async () => {
          const gb = Number($('setDataGB').value) || 0;
          if (!gb) { toast({ title: '先选一个容量', body: '「自动」表示由软件按磁盘余量决定，不需要扩容', type: 'info' }); return; }
          const { response } = await api.confirm({
            title: '立刻把安卓数据分区扩容？',
            message: `将把 /data 调整为 ${gb} GB（就地扩容，已装应用和存档都会保留）。`,
            detail: '扩容需要先关掉正在运行的安卓应用，完成后下次打开应用会重新引导，约多花十几秒。',
            okLabel: '开始扩容',
          });
          if (response !== 1) return;
          $('btnGrowData').disabled = true;
          const old = $('btnGrowData').textContent;
          $('btnGrowData').textContent = '扩容中…';
          const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
          $('btnGrowData').disabled = false;
          $('btnGrowData').textContent = old;
          if (r && !r.ok && r.needsReset) {
            // 快速启动的差量盘挡着：就地扩容做不到，只能按新容量重建 /data。
            // 这是明确的数据丢失操作，必须单独再确认一次。
            const again = await api.confirm({
              title: '需要重置安卓数据才能扩容',
              message: `安卓正在使用快速启动差量盘，就地扩容改不到它。要拿到 ${gb} GB 空间，必须按新容量重建 /data。`,
              detail: '重建会清空已安装的应用与存档（模拟器本身和镜像不受影响）。确定继续吗？',
              okLabel: '清空并重建',
            });
            if (again.response !== 1) { refreshDataInfo(); return; }
            $('btnGrowData').disabled = true;
            $('btnGrowData').textContent = '重建中…';
            const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
            $('btnGrowData').disabled = false;
            $('btnGrowData').textContent = old;
            toast({
              type: rr && rr.ok ? 'ok' : 'error',
              title: rr && rr.ok ? '已按新容量重建' : '重建失败',
              body: rr && rr.ok
                ? `下次打开应用会按 ${gb} GB 重建 /data（首次进入会多等几十秒）`
                : (rr && rr.error) || '未知错误',
            });
            refreshDataInfo();
            return;
          }
          toast({
            type: r && r.ok ? 'ok' : 'error',
            title: r && r.ok ? '数据分区已扩容' : '扩容失败',
            body: r && r.ok ? `现在约 ${r.fsGB || r.imageGB || gb} GB 可用` : (r && r.error) || '未知错误',
          });
          refreshDataInfo();
        });
      }
    }

    function bindMaintenance() {
      $('btnCleanup').addEventListener('click', async () => {
        const btn = $('btnCleanup');
        const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
        btn.disabled = true;
        try {
          const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
          if (preview?.ok !== true) throw new Error(preview?.error || '未收到清理预览');
          if (!preview.candidates.length) {
            toast({ title: '没有可回收的缓存', body: '系统镜像与其他安卓数据不会被自动删除。' });
            return;
          }
          const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
          if (r?.cancelled) return;
          if (r?.ok !== true && !r?.removed?.length) throw new Error(r?.error || '未确认清理完成');
          toast({
            title: r.ok ? '清理完成' : '仅完成部分清理',
            body: `释放约 ${((r.saved || 0) / 1048576).toFixed(0)} MB（${r.removed.length} 项）。${r.error || ''}`,
            type: r.ok ? 'ok' : 'error',
          });
          const u = await api.runtimeUsage();
          $('usageText').textContent = `共 ${u.totalText} · 可回收 ${u.reclaimableText}（${u.count} 项）`;
        } catch (e) {
          toast({ title: '清理失败', body: e.message, type: 'error' });
        } finally {
          btn.disabled = false;
        }
      });

      // 重置安卓数据：二级确认（先确认意图，再确认不可撤销），清完刷新占用统计
      $('btnResetData').addEventListener('click', async () => {
        const btn = $('btnResetData');
        btn.disabled = true;
        try {
          const first = await api.confirm({
            type: 'warning',
            title: '重置安卓数据？',
            message: '这会把安卓系统还原成「刚装好系统」的干净状态：',
            detail: '• 删除全部已安装的第三方应用及其数据、登录态\n'
              + '• 删除当前 AVD 的快速启动快照\n'
              + '• 系统镜像本身不受影响，重新打开应用会再次冷启动建数据\n\n'
              + '此操作不可撤销。是否继续？',
            buttons: ['取消', '继续'],
            defaultId: 0,
            cancelId: 0,
          });
          if (!first || first.response !== 1) return;
          const second = await api.confirm({
            type: 'warning',
            title: '再确认一次',
            message: '已安装的 app 和它们的数据将被永久删除，确定要重置吗？',
            detail: '可放心的是：系统镜像、其它 AVD、本机的 APK 缓存和图标都不会动。',
            buttons: ['取消', '确定重置'],
            defaultId: 0,
            cancelId: 0,
          });
          if (!second || second.response !== 1) return;
          const r = await api.runtimeResetData();
          if (!r || !r.ok) {
            toast({ title: '重置失败', body: (r && r.error) || '请重试', type: 'error' });
            return;
          }
          toast({
            title: '安卓数据已重置',
            body: `释放约 ${r.reclaimedMB} MB，已安装应用记录已清空。`,
            type: 'ok',
          });
          const u = await api.runtimeUsage();
          $('usageText').textContent = `共 ${u.totalText} · 可回收 ${u.reclaimableText}（${u.count} 项）`;
        } catch (e) {
          toast({ title: '重置失败', body: e.message, type: 'error' });
        } finally {
          btn.disabled = false;
        }
      });

      // Reconnect the owned guest only; a repaired link still requires fresh Internet validation.
      $('btnRepairNetwork').addEventListener('click', async () => {
        const btn = $('btnRepairNetwork');
        btn.disabled = true;
        try {
          const ok = await api.confirm({
            type: 'warning',
            title: '修复虚拟机网络？',
            message: '应用里需要联网的页面一直黑屏/转圈，通常是安卓虚拟机没有网络。',
            detail: '仅尝试重连当前安卓环境的模拟器网络，不会重启安卓，也不会改动 Windows 网络。是否继续？',
            okLabel: '开始修复',
            defaultId: 0,
            cancelId: 0,
          });
          if (!ok || ok.response !== 1) return;
          const r = await api.runtimeRepairNetwork();
          refreshStatus().catch(() => {});
          if (r?.ok !== true || r.network?.ok !== true) {
            toast({
              title: '网络仍未恢复',
              body: r?.error || networkExplanation(r?.network),
              type: 'error',
            });
            return;
          }
          toast({
            title: '已确认安卓能联网',
            body: r.network.ip || '',
            type: 'ok',
          });
        } catch (e) {
          toast({ title: '修复失败', body: e.message, type: 'error' });
        } finally {
          btn.disabled = false;
        }
      });

      // 清理旧版本残留：扫描旧程序目录 / 失效卸载项 / 更新临时文件，确认后一次性清掉。
      $('btnLeftovers').addEventListener('click', async () => {
        const btn = $('btnLeftovers');
        btn.disabled = true;
        try {
          const r = await api.leftoversScan();
          if (!r || !r.ok) {
            toast({ title: '扫描失败', body: (r && r.error) || '请重试', type: 'error' });
            return;
          }
          const items = r.items || [];
          if (!items.length) {
            toast({ title: '很干净', body: '没有发现旧版本残留。', type: 'ok' });
            return;
          }
          const mb = Math.round((r.totalBytes || 0) / 1048576);
          const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
          if (items.length > 8) lines.push(`…另有 ${items.length - 8} 项`);
          const ok = await api.confirm({
            type: 'warning',
            title: '清理旧版本残留？',
            message: `找到 ${items.length} 项残留，约 ${mb} MB：`,
            detail: `${lines.join('\n')}\n\n只删除「旧版本程序目录 / 已失效的卸载项 / 更新临时文件」，`
              + '当前正在运行的版本和你的应用数据都不会动。',
            buttons: ['取消', '开始清理'],
            defaultId: 1,
            cancelId: 0,
          });
          if (!ok || ok.response !== 1) return;
          const c = await api.leftoversClean(items);
          if (!c || !c.ok) {
            toast({ title: '清理失败', body: (c && c.error) || '请重试', type: 'error' });
            return;
          }
          const failNote = (c.failed && c.failed.length) ? `，${c.failed.length} 项被占用未删` : '';
          toast({
            title: '已清理旧版本残留',
            body: `删除 ${c.removed.length} 项，释放 ${c.freedMB || 0} MB${failNote}。`,
            type: 'ok',
          });
          const u = await api.runtimeUsage();
          $('usageText').textContent = `共 ${u.totalText} · 可回收 ${u.reclaimableText}（${u.count} 项）`;
        } catch (e) {
          toast({ title: '清理失败', body: e.message, type: 'error' });
        } finally {
          btn.disabled = false;
        }
      });
    }

    function bindIntegration() {
      $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
      $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
      $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
      $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
      $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));

      $('btnOpenShared').addEventListener('click', () => openDirectory(() => api.openSharedDir()));

      // 两个入口执行同一项操作，在请求完成前都暂停。
      const shortcutButtons = [$('btnRebuildShortcuts'), $('btnRebuildIntegrationShortcuts')];
      const rebuildShortcuts = async () => {
        for (const button of shortcutButtons) button.disabled = true;
        try {
          const r = await api.rebuildShortcuts();
          if (!r || r.ok === false) throw new Error(r?.error || '请重试');
          const fixed = r.fixed || [];
          toast(fixed.length
            ? { title: '快捷方式已重建', body: fixed.join('、'), type: 'ok' }
            : { title: '快捷方式都在', body: '没有需要重建的入口', type: 'info' });
        } catch (error) {
          toast({ title: '重建快捷方式失败', body: error.message, type: 'error' });
        } finally {
          for (const button of shortcutButtons) button.disabled = false;
        }
      };
      for (const button of shortcutButtons) button.addEventListener('click', rebuildShortcuts);

      // 共享目录：先浏览选目录，再「保存并迁移」把旧文件一次性搬到新目录
      $('btnBrowseShared').addEventListener('click', async () => {
        const picked = await api.openDir();
        if (!picked) return;
        $('setSharedDir').value = picked;
        toast({ title: '已选新目录', body: '点「保存并迁移」把旧文件搬过去', type: 'info' });
      });
      $('btnSaveShared').addEventListener('click', async () => {
        const dir = $('setSharedDir').value.trim();
        if (!dir) { toast({ title: '请先填写或浏览目录', type: 'error' }); return; }
        const btn = $('btnSaveShared');
        btn.disabled = true;
        try {
          const r = await api.setSharedDir(dir);
          if (r?.ok !== true) throw new Error(r?.error || '未收到迁移确认');
          $('setSharedDir').value = r.path || dir;
          toast({ title: '共享目录已更新', body: r.copied ? `已复制 ${r.copied} 项，旧文件保留。` : '没有新文件需要迁移。', type: 'ok' });
        } catch (e) {
          toast({ title: '共享目录未修改', body: e.message, type: 'error' });
        } finally { btn.disabled = false; }
      });

      // 一键卸载 ApkStart 本体（取消 .apk 关联 + 启动卸载程序；便携版手动删除）
      $('btnUninstall').addEventListener('click', async () => {
        const ok = window.confirm('确定卸载 ApkStart？\n\n将取消 .apk 文件关联并移除程序。此操作不可撤销。');
        if (!ok) return;
        const btn = $('btnUninstall');
        btn.disabled = true;
        const r = await api.removeSelf().catch(() => ({ ok: false }));
        if (r.ok && r.portable) {
          btn.disabled = false;
          toast({
            title: '便携版无法自动卸载',
            body: `请手动删除程序目录（${r.exeDir}）与数据目录（${r.dataDir}）`,
            type: 'info', sticky: true,
          });
          return;
        }
        if (!r.ok) {
          btn.disabled = false;
          toast({ title: '卸载失败', body: r.error, type: 'error' });
          return;
        }
        toast({ title: '正在卸载…', body: '卸载程序已启动，ApkStart 即将退出', type: 'ok', sticky: true });
      });

      $('btnOpenData').addEventListener('click', () => openDirectory(() => api.runtimeOpenDirectory('runtime')));
      $('btnBrowseRuntimeDir').addEventListener('click', async () => {
        try {
          const picked = await api.openDir();
          if (!picked) return;
          const r = await api.setSettings({ runtime: { dir: picked } });
          if (!r?.runtime || r.ok === false) throw new Error(r?.error || '没有收到目录保存确认');
          const active = await api.info();
          $('setRuntimeDir').value = active.runtimeDir || active.dataDir;
          toast({ title: '部署目录已保存', body: '旧文件没有被移动或删除。', type: 'ok' });
          await refreshDataInfo();
        } catch (e) {
          toast({ title: '部署目录未更新', body: e.message, type: 'error' });
        }
      });

      // 安卓数据目录（AVD + 快照）：真正吃盘的那块，单独指到别的盘
      if ($('btnBrowseAvdDir')) {
        $('btnBrowseAvdDir').addEventListener('click', async () => {
          try {
            const picked = await api.openDir();
            if (!picked) return;
            const r = await api.setSettings({ runtime: { avdDir: picked } });
            if (!r?.runtime || r.ok === false) throw new Error(r?.error || '未收到目录保存确认');
            const info = await api.dataInfo();
            $('setAvdDir').value = info.avdDir || '';
            toast(info.avdDirConflict ? {
              title: '仍在使用原来的安卓数据',
              body: `新目录未接管；当前有效目录为 ${info.avdDirConflict.current}。请保留原目录。`,
              type: 'info', sticky: true,
            } : { title: '安卓数据目录已保存', body: '旧安卓数据没有被搬移或删除。', type: 'ok' });
            await refreshDataInfo();
          } catch (e) {
            toast({ title: '安卓数据目录未更新', body: e.message, type: 'error' });
          }
        });
      }
      if ($('btnOpenAvdDir')) {
        $('btnOpenAvdDir').addEventListener('click', () => openDirectory(() => api.runtimeOpenDirectory('avd')));
      }

      $('btnAssoc').addEventListener('click', async () => {
        const btn = $('btnAssoc');
        btn.disabled = true;
        try {
          const mode = btn.dataset.mode;
          if (mode === 'choose') {
            const r = await api.assocOpenDefaultSettings();
            if (r?.ok !== true) throw new Error(r?.error || '未打开默认应用设置');
            toast({ title: '请在 Windows 设置中选择 .apk 默认应用' });
            return;
          }
          const r = mode === 'effective' ? await api.assocUnregister() : await api.assocRegister();
          await refreshAssoc();
          if (r?.needsDefaultSelection) {
            btn.dataset.mode = 'choose';
            btn.textContent = '转到 Windows 默认应用';
            toast({ title: '还需要在 Windows 中确认默认应用', body: r.error || '点击按钮打开 Windows 设置。' });
          } else if (r?.ok !== true) {
            throw new Error(r?.error || 'Windows 没有确认关联已更新');
          } else if (mode === 'effective') {
            toast(r.removed ? { title: '本实例的 .apk 关联已取消', type: 'ok' }
              : { title: '无本实例的关联需要取消' });
          } else if (r.effective) {
            toast({ title: '已确认 .apk 默认由本实例打开', type: 'ok' });
          }
        } catch (e) {
          toast({ title: 'APK 关联未确认', body: e.message, type: 'error' });
        } finally {
          btn.disabled = false;
        }
      });
    }

    async function openDirectory(open) {
      try {
        const r = await open();
        if (r?.ok !== true) throw new Error(r?.error || '没有收到打开目录的确认');
      } catch (e) {
        toast({ title: '未打开目录', body: e.message, type: 'error' });
      }
    }

    async function refreshAssoc() {
      const btn = $('btnAssoc');
      if (!btn) return;
      const r = await api.assocStatus();
      btn.dataset.mode = r?.effective ? 'effective' : r?.registered ? 'choose' : 'register';
      btn.textContent = r?.effective ? '已生效 · 点击取消'
        : r?.registered ? '已注册候选 · 选择 Windows 默认应用' : '未确认默认关联 · 点击注册';
    }

    function bind() {
      bindPartition();
      bindMaintenance();
      bindIntegration();
    }

    return { bind, refreshDataInfo, refreshAssoc };
  };
})();
