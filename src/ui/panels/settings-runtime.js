'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createRuntimeSettings = function createRuntimeSettings({ api, $, state, save, toast, fillSettings, refreshStatus }) {
    /** 本机资源上限 + 当前分配（设置页里那几行灰字） */
    async function refreshResources() {
      const bNote = $('builtinResNote');
      if (!bNote) return;
      const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : '未知');
      const r = await api.resources().catch(() => null);
      if (!r || r.ok === false) {
        bNote.textContent = (r && (r.note || r.error)) || '暂时读不到资源分配信息';
        return;
      }
      const host = r.host || {};
      const lim = r.limits || {};
      const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
      bNote.textContent = `本机 ${gb(host.totalMB)} 内存 / ${host.cores} 核；`
        + `内存最多可分 ${gb(lim.maxMB)}，核心最多 ${Math.max(1, (host.cores || 1) - 1)} 个（各留 1/4 内存与 1 核给 Windows）。`
        + `数据分区上限 ${lim.maxGB || 0} GB${free ? `（所在磁盘剩余 ${(free / 1024).toFixed(1)} GB）` : ''}。`
        + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
    }

    function renderCompatImage(env) {
        const image = env.playImage;
        $('compatInstallField').hidden = !image || !!image.ok;
        $('compatImgStatus').textContent = image?.ok
          ? `已就绪（${(image.size / 1073741824).toFixed(2)} GB）` : '未下载';
    }

    function bindResources() {
      $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
      $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
      // 内存 / 核心：填了具体值就关掉「自动」，填 0 又回到自动。
      // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
      // 于是「手动填了内存」一直被忽略 —— 这是设置页最容易被当成“没用”的一项。
      $('setMemory').addEventListener('change', (e) => {
        const v = Number(e.target.value) || 0;
        save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
      });
      $('setCores').addEventListener('change', (e) => {
        save({ engine: { cores: Number(e.target.value) || 0 } });
      });
      if ($('setResourceMode')) {
        $('setResourceMode').addEventListener('change', async (e) => {
          // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
          state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
          fillSettings(state.settings);
          toast({ title: '资源策略已切换', body: '下一次打开应用生效', type: 'ok' });
        });
      }
      if ($('setRenderSize')) {
        $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
      }
      if ($('setFastDns')) {
        $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
      }
      if ($('setLocale')) {
        $('setLocale').addEventListener('change', async (e) => {
          state.settings = await api.setSettings({ engine: { locale: e.target.value } });
          toast({ title: '系统语言已更新', body: '下次重启安卓运行时后生效', type: 'ok' });
        });
      }
      if ($('setChineseIme')) {
        $('setChineseIme').addEventListener('change', async (e) => {
          state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked } });
          toast({
            title: e.target.checked ? '已开启中文输入法' : '已关闭中文输入法',
            body: '下次重启安卓运行时后生效',
            type: 'ok',
          });
        });
      }
      if ($('setKeepSnapshot')) {
        $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
      }
    }

    function bindPreferences() {
      $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
      if ($('setSourcePref')) {
        $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
      }
      if ($('setAutoMirror')) {
        $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
      }
      if ($('setGiteeToken')) {
        $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
      }
      if ($('setMirrorPrefix')) {
        $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
      }
      if ($('setConnections')) {
        $('setConnections').addEventListener('change', (e) => {
          const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
          e.target.value = n;
          save({ runtime: { downloadConnections: n } });
        });
      }
      $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
      $('setHostMicrophone').addEventListener('change', async (e) => {
        const control = e.target;
        const requested = control.checked;
        control.disabled = true;
        try {
          const next = await api.setSettings({ engine: { hostMicrophone: requested } });
          state.settings = next;
          control.checked = next.engine.hostMicrophone === true;
          toast({
            title: requested ? '已保存麦克风开启' : '已保存麦克风关闭',
            body: requested ? '重启安卓运行时后生效；还需在安卓里授予目标应用麦克风权限。'
              : '如果安卓运行时还在运行，请停止或重启它，才会停止传入麦克风声音。',
          });
        } catch (error) {
          control.checked = state.settings?.engine?.hostMicrophone === true;
          toast({ type: 'error', title: '无法保存麦克风设置', body: error.message });
        } finally {
          control.disabled = false;
        }
      });
      $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
      $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
      $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));

      // 实验室：多开开关与后台保留数。改完提示下次打开应用生效（切换应用路径才读它）。
      if ($('setMultiWindow')) {
        $('setMultiWindow').addEventListener('change', (e) => {
          save({ engine: { multiWindow: e.target.checked } });
          toast({
            title: e.target.checked ? '多窗口多开已开启（实验性）' : '已回到单应用模式',
            body: e.target.checked ? '下次打开应用生效：多个应用可并存、各自独立原生窗口。' : '',
            type: 'ok',
          });
        });
      }
      if ($('setKeepBackground')) {
        $('setKeepBackground').addEventListener('change', (e) => {
          save({ engine: { keepBackground: Number(e.target.value) } });
        });
      }
      $('setDeepTrim').addEventListener('change', async (e) => {
        await save({ engine: { deepTrim: e.target.checked } });
        // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来，否则影响是持久的
        if (!e.target.checked) {
          api.restoreSystemApps().catch(() => {});
          toast({ title: '已恢复系统组件', body: '深度裁剪关闭，后台包正在恢复', type: 'info' });
        }
      });
      $('setCompat').addEventListener('change', async (e) => {
        await save({ runtime: { compatImage: e.target.checked } });
        renderCompatImage((state.status = await api.runtimeStatus()).env || {});
      });
    }

    function bindRuntimeButtons() {
      // ARM 兼容镜像下载（带进度 toast）
      $('btnInstallPlay').addEventListener('click', async () => {
        const btn = $('btnInstallPlay');
        btn.disabled = true;
        const t = toast({ title: '开始下载 ARM 兼容镜像', body: '准备中…', sticky: true, spinner: true, progress: 3 });
        const un = api.on('provision:progress', (p) => {
          if (p.component !== 'playimg') return;
          t.update({ title: '下载 ARM 兼容镜像', body: p.message || '', progress: p.percent });
        });
        try {
          const r = await api.installPlayImage();
          if (r && r.ok) {
            t.update({ title: 'ARM 兼容镜像就绪', body: '重启运行时后生效', progress: 100 });
            setTimeout(() => t.dismiss(), 3000);
            $('compatInstallField').hidden = true;
            refreshStatus();
          } else {
            t.update({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', progress: null });
            t.dismiss();
            toast({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', type: 'error' });
          }
        } catch (e) {
          t.dismiss();
          toast({ title: '兼容镜像下载失败', body: e.message, type: 'error' });
        } finally {
          un();
          btn.disabled = false;
        }
      });

      // 下载入口取决于镜像是否就绪，不再依赖旧版兼容开关。
      api.runtimeStatus().then((status) => {
        state.status = status;
        renderCompatImage(status.env || {});
      }).catch(() => {});

      $('btnRuntimeStart').addEventListener('click', async () => {
        const el = $('probeResult');
        el.textContent = '正在启动…';
        const r = await api.runtimeStart();
        el.textContent = r.ok ? `已就绪：${r.engine}` : `启动失败：${r.error}`;
        refreshStatus();
      });

      $('btnRuntimeStop').addEventListener('click', async () => {
        const r = await api.runtimeStop().catch((error) => ({ ok: false, error: error.message }));
        $('probeResult').textContent = r?.ok ? '已停止内置虚拟机' : `停止失败：${r?.error || '没有确认已停止'}`;
        refreshStatus();
      });
    }

    function bind() {
      bindResources();
      bindPreferences();
      bindRuntimeButtons();
    }

    return { bind, refreshResources };
  };
})();
