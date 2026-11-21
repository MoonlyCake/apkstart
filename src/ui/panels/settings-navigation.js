'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createSettingsNavigation = function createSettingsNavigation({ $, onFilterChanged }) {
    const SETTINGS_CATS = [
      { id: 'basic', name: '常用与安装' },
      { id: 'display', name: '显示与窗口' },
      { id: 'input', name: '操作与输入' },
      { id: 'perf', name: '性能与资源' },
      { id: 'net', name: '网络与下载' },
      { id: 'diag', name: '诊断与修复' },
      { id: 'files', name: '集成与文件' },
      { id: 'about', name: '更新与关于' },
      { id: 'lab', name: '实验室' },
    ];

    const settingsCatState = { cat: 'basic', query: '' };

    /** 设置里所有带分类标记的分组（.group 和 details.advanced-group 都算） */
    function settingsGroups() {
      return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
    }

    /** 分组内是否命中搜索词：标题、字段名、说明文字都算 */
    function groupMatches(group, q) {
      if (!q) return true;
      const text = (group.textContent || '').toLowerCase();
      if (text.includes(q)) return true;
      const title = group.querySelector('.group-title');
      return !!title && title.textContent.toLowerCase().includes(q);
    }

    /** 切到某个分类 */
    function switchSettingsCat(cat, { keepQuery = false } = {}) {
      const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
      settingsCatState.cat = target;
      if (!keepQuery) settingsCatState.query = '';
      try { localStorage.setItem('apkstart.settings.cat', target); } catch (_) { /* ignore */ }
      const search = $('setSearch');
      if (search && !keepQuery) search.value = '';
      const clear = $('btnClearSearch');
      if (clear) clear.hidden = !settingsCatState.query;
      document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
        b.classList.toggle('on', b.dataset.cat === target);
      });
      applySettingsFilter();
    }

    /**
     * 应用可见性：搜索时跨分类展示命中的分组（否则搜到的东西藏在别的分类里，
     * 用户会以为「搜了没反应」）；没搜索时只显示当前分类。
     */
    function applySettingsFilter() {
      const q = settingsCatState.query.trim().toLowerCase();
      const groups = settingsGroups();
      const hitPerCat = {};
      for (const g of groups) {
        const hit = groupMatches(g, q);
        const inCat = g.dataset.cat === settingsCatState.cat;
        g.hidden = q ? !hit : !inCat;
        if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
      }
      // 分类按钮：搜索时标出哪些分类有命中项
      document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
        const n = hitPerCat[b.dataset.cat] || 0;
        b.classList.toggle('dim', !!q && n === 0);
        b.title = q ? `${n} 项命中` : '';
      });
      // 最后一个可见分组不画分隔线（分组被隐藏后 :last-child 会选错对象）
      const visible = groups.filter((g) => !g.hidden);
      visible.forEach((g) => g.classList.remove('last-visible'));
      if (visible.length) visible[visible.length - 1].classList.add('last-visible');
      onFilterChanged();
    }

    /** 定位到某个分组：先切到它所属的分类，再滚动过去 */
    function focusGroup(el) {
      if (!el) return;
      const cat = el.dataset && el.dataset.cat;
      if (cat) switchSettingsCat(cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }

    function bindSettingsCategory() {
      const nav = $('setNav');
      if (nav) {
        nav.addEventListener('click', (e) => {
          const btn = e.target.closest('.set-nav-item');
          if (!btn) return;
          switchSettingsCat(btn.dataset.cat);
          const body = $('settingsBody');
          if (body) body.scrollTop = 0;
        });
      }

      const search = $('setSearch');
      const clear = $('btnClearSearch');
      if (search) {
        search.addEventListener('input', () => {
          settingsCatState.query = search.value || '';
          if (clear) clear.hidden = !settingsCatState.query;
          applySettingsFilter();
        });
        // 回车：跳到第一个命中的分组
        search.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const hit = settingsGroups().find((g) => !g.hidden);
          if (hit) focusGroup(hit);
        });
      }
      if (clear) {
        clear.addEventListener('click', () => {
          settingsCatState.query = '';
          if (search) search.value = '';
          clear.hidden = true;
          applySettingsFilter();
        });
      }

      // 记住上次停留的分类
      try {
        const last = localStorage.getItem('apkstart.settings.cat');
        if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
      } catch (_) { /* ignore */ }
      switchSettingsCat(settingsCatState.cat);
    }

    return { bind: bindSettingsCategory, focus: focusGroup, refresh: applySettingsFilter };
  };
})();
