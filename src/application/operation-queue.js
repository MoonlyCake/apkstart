'use strict';

// Serialize app operations that share one guest. The same pending key reuses
// exactly one execution; a rejected task must not poison the queue.
class OperationQueue {
  #tail = Promise.resolve();
  #pending = new Map();

  get size() { return this.#pending.size; }
  has(key) { return this.#pending.has(key); }

  run(key, task) {
    if (this.#pending.has(key)) return this.#pending.get(key);
    const pending = this.#tail.then(() => task()).finally(() => this.#pending.delete(key));
    this.#pending.set(key, pending);
    this.#tail = pending.catch(() => {});
    return pending;
  }
}

module.exports = { OperationQueue };
