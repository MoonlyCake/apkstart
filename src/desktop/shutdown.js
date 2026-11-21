'use strict';

function createDesktopShutdown({ stopBackground, parkWindow, disposeAgent, releaseRuntime, closeDecoder, quit, log }) {
  let completion;
  let ready = false;
  async function step(label, effect) {
    try { await effect(); } catch (error) { log(`${label} failed: ${error.message}`); }
  }
  return {
    get ready() { return ready; },
    beforeQuit(event) {
      if (ready) return;
      event.preventDefault();
      completion ??= Promise.resolve().then(async () => {
        await step('stop background', stopBackground);
        // Window park is a native operation. The helper must stay connected until it settles.
        await step('park app window', parkWindow);
        await step('dispose window agent', disposeAgent);
        await step('release runtime', releaseRuntime);
        await step('close decoder', closeDecoder);
        ready = true;
        quit();
      });
      return completion;
    },
  };
}

module.exports = { createDesktopShutdown };
