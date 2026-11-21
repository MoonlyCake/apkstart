'use strict';

const assert = require('node:assert/strict');
const { registerIpc } = require('../../src/ipc');

function captureHandlers(dependencies = {}) {
  const handlers = new Map();
  registerIpc({
    handle(channel, handler) {
      assert(!handlers.has(channel), `Duplicate IPC handler: ${channel}`);
      handlers.set(channel, handler);
    },
  }, { live: {}, ...dependencies });
  return handlers;
}

module.exports = { captureHandlers };
