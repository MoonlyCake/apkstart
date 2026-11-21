'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createUpdatesPanel = function createUpdatesPanel({ api, $, toast }) {
    let lastUpdate = null;

    /** 把一次检查结果画到设置面板（也用于启动时静默检查推送过来的状态） */
    function renderUpdate(info) {
      lastUpdate = info || null;
      const cur = $('updateCurrent');
      const st = $('updateState');
      const btn = $('btnDoUpdate');
      const bar = $('updateBar');
      if (!cur || !st || !btn) return;
      if (!info) return;
      if (info.current) cur.textContent = `v${info.current}`;

      if (info.ok === false) {
        st.textContent = `检查失败：${info.error || '网络不可用'}`;
        // 检查失败也要给一条出路：直接把发布页打开，用户至少能手动下载。
        // 以前这里是「什么都不显示」，用户只会觉得「更新功能坏了」。
        showUpdateBtn(true);
        btn.textContent = '打开下载页';
        btn.dataset.mode = 'manual';
        lastUpdate = { htmlUrl: info.htmlUrl || '' };
        if (bar) bar.hidden = true;
        return;
      }
      if (info.hasUpdate) {
        st.textContent = `发现新版本 ${info.tag}`;
        showUpdateBtn(true);
        btn.textContent = info.asset ? '立即更新' : '打开下载页';
        btn.dataset.mode = info.asset ? 'auto' : 'manual';
        const note = $('updateNote');
        if (note && info.notes) {
          const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
          if (brief) note.textContent = `更新内容：\n${brief}`;
        }
        if (bar) bar.hidden = true;
      } else {
        st.textContent = info.releasePublished === false
          ? `尚无正式发布（当前 v${info.current}）`
          : `已是最新版本（v${info.current}）`;
        showUpdateBtn(false);
        if (bar) bar.hidden = true;
      }
    }

    /** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
    function showUpdateBtn(on) {
      const btn = $('btnDoUpdate');
      if (!btn) return;
      btn.hidden = !on;
      btn.style.display = on ? '' : 'none';
    }

    function renderUpdateProgress(p) {
      if (!p) return;
      const st = $('updateState');
      const bar = $('updateBar');
      const fill = $('updateBarFill');
      if (p.stage === 'error') {
        if (st) st.textContent = `更新失败：${p.message || ''}`;
        if (bar) bar.hidden = true;
        toast({ title: '更新失败', body: p.message || '', type: 'error' });
        return;
      }
      if (st) st.textContent = p.message || '正在更新…';
      if (bar && fill) {
        bar.hidden = false;
        fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
      }
    }

    function bindUpdate() {
      const check = $('btnCheckUpdate');
      const go = $('btnDoUpdate');
      if (!check || !go) return;

      const runCheck = async (silent) => {
        if (!silent) {
          check.disabled = true;
          const old = check.textContent;
          check.textContent = '检查中…';
          $('updateState').textContent = '正在检查本项目的 GitHub 发行版…';
          try {
            const info = await api.updateCheck();
            renderUpdate(info);
            if (info && info.hasUpdate) toast({ title: `发现新版本 ${info.tag}`, body: '点「立即更新」自动下载安装', type: 'info' });
            else if (info && info.ok !== false) toast({ title: '已是最新版本', body: `v${info.current}`, type: 'ok' });
          } catch (e) {
            $('updateState').textContent = `检查失败：${e.message}`;
          } finally {
            check.disabled = false;
            check.textContent = old;
          }
          return;
        }
        const info = await api.updateCheck().catch(() => null);
        if (info) renderUpdate(info);
      };

      check.addEventListener('click', () => runCheck(false));

      go.addEventListener('click', async () => {
        if (go.dataset.mode === 'manual') {
          api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
          return;
        }
        go.disabled = true;
        go.textContent = '更新中…';
        const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
        if (!r || !r.ok) {
          go.disabled = false;
          go.textContent = '立即更新';
          if (r && r.error && !r.manual) {
            $('updateState').textContent = `更新失败：${r.error}`;
            toast({ title: '更新失败', body: r.error, type: 'error' });
          }
        } else {
          $('updateState').textContent = `已下载 v${r.version}，正在重启完成安装…`;
        }
      });

      // 打开设置时如果还没结果，就顺手查一次（放后台，不打扰）
      runCheck(true).catch(() => {});
    }

    return {
      bind: bindUpdate, render: renderUpdate, progress: renderUpdateProgress,
      get availableVersion() { return lastUpdate?.hasUpdate ? lastUpdate.tag || '' : null; },
    };
  };
})();
