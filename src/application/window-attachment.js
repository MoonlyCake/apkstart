'use strict';

// Make the early attach and the final fallback share one in-flight promise.
// Failed early attempts are retried after the app has become stable.
function createWindowAttachment(attach) {
  let early;
  const attempt = () => Promise.resolve().then(() => attach()).then(Boolean, () => false);
  return {
    startEarly() {
      early ??= attempt();
      return early;
    },
    settleEarly() { return early; },
    async finish() {
      return (early && await early) || await attempt();
    },
  };
}

module.exports = { createWindowAttachment };
