'use strict';

const container = require('../core/container');
const { validPackageName } = require('../core/pkgname');

/** Owns app/window generations and foreground/parking policy, not VM or window handles. */
class AppSessions {
  #entries = new Map();
  #current = null;
  #guest = 0;
  #tail = Promise.resolve();
  #active = false;

  constructor({ getSettings, getApps, getClient, touch, cancelSnapshot, scheduleSnapshot, setPriority, onActivityChanged, log }) {
    this.effects = { getSettings, getApps, getClient, touch, cancelSnapshot, scheduleSnapshot, setPriority, onActivityChanged, log };
  }

  get currentTicket() { return this.#current; }
  get currentPackage() { return this.#current?.pkg ?? null; }
  get isIdle() { return ![...this.#entries.values()].some((entry) => entry.phase !== 'dormant'); }

  hasActive(pkg) { return this.#entries.get(pkg)?.phase === 'active'; }
  isCurrent(ticket) { return !!ticket && this.#current === ticket; }

  reserve(pkg, { reuse = false } = {}) {
    if (!validPackageName(pkg)) throw new Error('无效的安卓应用包名');
    const previous = this.#entries.get(pkg);
    const ticket = reuse && previous ? previous.ticket : Object.freeze({ pkg });
    if (ticket !== previous?.ticket) {
      this.#entries.delete(pkg);
      this.#entries.set(pkg, { ticket, phase: 'opening' });
      this.#publishActivity();
    } else if (previous.phase === 'dormant') {
      previous.phase = 'opening';
    }
    this.#current = ticket;
    this.effects.touch();
    return ticket;
  }

  async waitForTurn(ticket) {
    await this.#tail;
    return this.isCurrent(ticket);
  }

  activate(ticket) {
    const guest = this.#guest;
    return this.#queue(async () => {
      if (!this.#matches(ticket, guest)) return null;
      const { pkg } = ticket;
      const { getSettings, getApps, getClient, cancelSnapshot, setPriority, log } = this.effects;
      const engine = getSettings().engine || {};
      const client = getClient();
      const entry = this.#entries.get(pkg);
      if (!this.#active) cancelSnapshot();
      this.#entries.delete(pkg);
      entry.phase = 'active';
      this.#entries.set(pkg, entry);
      this.#publishActivity();

      // Returning to a warm session must raise its priority again after parking.
      await setPriority(engine.priorityMode === 'game' ? 'game' : 'normal').catch(() => {});
      if (!this.#matches(ticket, guest)) return null;
      const active = this.#activePackages();
      if (engine.multiWindow) {
        const roles = container.sessionRoles(active, pkg);
        const { tombstone } = container.planTombstones({
          background: roles.background,
          keepRecent: Number(engine.keepBackground) >= 0 ? Number(engine.keepBackground) : 1,
        });
        const commands = container.buildTombstoneCommands(tombstone);
        if (commands.length) await client.shell(commands.join(' ; '), { timeout: 20000 }).catch(() => '');
        if (!this.#matches(ticket, guest)) return null;
        log(`多窗口：前台 ${pkg}，保留后台 ${roles.background.length - tombstone.length} 个，计划回收 ${tombstone.length} 个`);
        return { ...roles, plan: { commands, stopped: tombstone } };
      }
      const installed = getApps().map((app) => app?.package).filter(Boolean);
      const state = container.nextSessionState(active, 'open', pkg);
      const plan = container.buildSessionCommands({ pkg, installed, deep: !!engine.deepTrim });
      if (plan.commands.length) await client.shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
      if (!this.#matches(ticket, guest)) return null;
      log(container.describeSession(state, plan));
      return { ...state, plan };
    });
  }

  close(ticket) {
    const phase = this.#drop(ticket);
    if (!phase || phase === 'dormant') return Promise.resolve(this.#state());
    return this.#stopPackage(ticket.pkg, { canPark: true });
  }

  stop(pkg) {
    if (!validPackageName(pkg)) return Promise.reject(new Error('无效的安卓应用包名'));
    const entry = this.#entries.get(pkg);
    // Closing an already-dismissed window is best effort; an explicit stop must wait for Android.
    return this.#stopPackage(pkg, { canPark: !!entry, ticket: entry?.ticket, strict: true });
  }

  discard(ticket) { return !!this.#drop(ticket); }

  guestStopped() {
    this.#guest += 1;
    // The shell window may survive a repanel, but its old guest is no longer active.
    for (const [pkg, entry] of this.#entries) {
      if (entry.ticket !== this.#current) this.#entries.delete(pkg);
      else if (entry.phase === 'active') entry.phase = 'dormant';
    }
    this.#publishActivity();
  }

  #stopPackage(pkg, { canPark = false, ticket, strict = false } = {}) {
    const guest = this.#guest;
    const current = () => guest === this.#guest && this.#entries.get(pkg)?.ticket === ticket;
    const stale = () => {
      if (strict) throw new Error('应用会话或安卓运行时已切换，停止请求未完成');
      return this.#state();
    };
    return this.#queue(async () => {
      // A delayed event from a prior window must not stop a reopened copy.
      if (!current()) return stale();
      const { getClient, getSettings, setPriority, scheduleSnapshot, log } = this.effects;
      let client;
      try {
        client = getClient();
        if (!client) throw new Error('安卓运行时尚未连接');
        if (await client.forceStop(pkg) === false) throw new Error('Android 未确认停止应用');
      } catch (error) {
        if (strict) throw error;
        log(`窗口已关闭，但未能停止 ${pkg}：${error.message}`);
        return this.#state();
      }
      if (!current()) return stale();
      if (ticket) this.#drop(ticket);
      if (canPark && guest === this.#guest && this.isIdle) {
        const engine = getSettings().engine || {};
        const commands = container.buildIdleCommands({ deep: !!engine.deepTrim });
        await client.shell(commands.join(' ; '), { timeout: 15000 }).catch(() => '');
        if (guest === this.#guest && this.isIdle) {
          await setPriority(engine.priorityMode === 'game' ? 'normal' : 'idle').catch(() => {});
          if (guest === this.#guest && this.isIdle) {
            scheduleSnapshot(8000);
            log('容器已停放（Android 常驻，无活跃应用窗口）');
          }
        }
      }
      return this.#state();
    });
  }

  #queue(action) {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }

  #drop(ticket) {
    const entry = ticket && this.#entries.get(ticket.pkg);
    if (!entry || entry.ticket !== ticket) return null;
    this.#entries.delete(ticket.pkg);
    if (this.#current === ticket) this.#current = [...this.#entries.values()].at(-1)?.ticket ?? null;
    this.#publishActivity();
    return entry.phase;
  }

  #matches(ticket, guest) {
    return guest === this.#guest && !!ticket && this.#entries.get(ticket.pkg)?.ticket === ticket;
  }

  #activePackages() {
    return [...this.#entries].filter(([, entry]) => entry.phase === 'active').map(([pkg]) => pkg);
  }

  #state() {
    return container.nextSessionState(this.#activePackages());
  }

  #publishActivity() {
    const active = [...this.#entries.values()].some((entry) => entry.phase === 'active');
    if (active === this.#active) return;
    this.#active = active;
    try { this.effects.onActivityChanged(active); } catch (error) {
      this.effects.log(`应用会话后台任务切换失败：${error.message}`);
    }
  }
}

module.exports = { AppSessions };
