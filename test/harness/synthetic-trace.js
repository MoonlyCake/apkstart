'use strict';

const assert = require('node:assert/strict');
const FORMAT = 'apkstart/synthetic-lifecycle-v1';

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

/** Record only explicitly supplied synthetic operations; never intercept OS transports. */
function recordSyntheticTrace(respond) {
  const steps = [];
  return {
    call(operation, ...args) {
      const step = { operation, args: cloneJson(args) };
      steps.push(step);
      let result;
      try {
        result = respond(operation, ...args);
      } catch (error) {
        step.error = { message: error.message, ...(error.code ? { code: error.code } : {}) };
        throw error;
      }
      // This adapter is intentionally synchronous: fixtures supply logical data, not I/O.
      step.result = cloneJson(result ?? null);
      return result;
    },
    fixture() { return cloneJson({ format: FORMAT, steps }); },
  };
}

function replaySyntheticTrace(fixture) {
  assert.equal(fixture.format, FORMAT, 'only synthetic lifecycle traces are supported');
  let index = 0;
  let mismatch;
  return {
    call(operation, ...args) {
      if (mismatch) throw mismatch;
      const expected = fixture.steps[index++];
      try {
        assert.deepEqual({ operation, args }, expected && { operation: expected.operation, args: expected.args },
          `synthetic step ${index} differs (called ${operation})`);
      } catch (error) {
        // Runtime recovery can catch transport errors; it must not hide an invalid test fixture.
        mismatch = error;
        throw error;
      }
      if (expected.error) throw Object.assign(new Error(expected.error.message), expected.error);
      return cloneJson(expected.result);
    },
    assertComplete() {
      if (mismatch) throw mismatch;
      assert.equal(index, fixture.steps.length, 'synthetic trace has unconsumed steps');
    },
  };
}

module.exports = { recordSyntheticTrace, replaySyntheticTrace };
