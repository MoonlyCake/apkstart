'use strict';

/** Serializes operations on the one managed guest. Drivers still decide whether it is ready. */
class RuntimeLifecycle {
  #ensure;
  #stop;
  #tail = Promise.resolve();
  #last;
  #phase = 'idle';

  constructor({ ensure, stop }) {
    this.#ensure = ensure;
    this.#stop = stop;
  }

  get phase() { return this.#phase; }

  ensure(options) {
    // A stop/restart/maintenance request separates starts even while both are queued.
    return this.#last?.phase === 'ensuring'
      ? this.#last.promise
      : this.#enqueue('ensuring', () => this.#ensure(options));
  }

  stop(options) {
    return this.#enqueue('stopping', () => this.#stop(options));
  }

  restart({ graceful = true, check, beforeBoot, onLog } = {}) {
    return this.#enqueue('restarting', async () => {
      const blocked = check?.();
      if (blocked) return blocked;
      // Call the driver, not the public queue methods, inside this atomic transition.
      if (!await this.#stop({ graceful })) {
        return { ok: false, reason: 'stop-failed', error: '无法确认旧安卓运行时已关闭。' };
      }
      if (beforeBoot) await beforeBoot();
      return this.#ensure({ onLog });
    });
  }

  maintain(task) {
    return this.#enqueue('maintaining', task);
  }

  #enqueue(phase, task) {
    const entry = { phase, promise: null };
    entry.promise = this.#tail.then(() => {
      this.#phase = phase;
      return task();
    }).finally(() => {
      this.#phase = 'idle';
      if (this.#last === entry) this.#last = undefined;
    });
    this.#last = entry;
    // The failure still reaches its caller; only the sequencing tail recovers.
    this.#tail = entry.promise.then(() => {}, () => {});
    return entry.promise;
  }
}

module.exports = { RuntimeLifecycle };
