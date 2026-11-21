'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Retain a leading BOM when replacing an existing file. Reject invalid UTF-8
// rather than converting damaged bytes to replacement characters on save.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function stateFileError(file, code, message, cause) {
  const error = new Error(`${path.basename(file)}: ${message}`, { cause });
  error.code = code;
  error.path = file;
  return error;
}

function assertShape(file, value, isValid) {
  if (!isValid(value)) {
    throw stateFileError(file, 'STATE_INVALID_SHAPE', 'unexpected state format');
  }
}

function readJsonFile(file, fallback, isValid) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { value: fallback, bom: false };
    throw stateFileError(file, error.code, 'cannot read state file', error);
  }

  let bom;
  let value;
  try {
    const text = utf8.decode(bytes);
    bom = text.startsWith('\uFEFF');
    value = JSON.parse(bom ? text.slice(1) : text);
  } catch (cause) {
    throw stateFileError(file, 'STATE_INVALID_JSON', 'must contain valid UTF-8 JSON', cause);
  }
  assertShape(file, value, isValid);
  return { value, bom };
}

// Publish a complete file by rename in the same directory. Close the handle
// before renaming on Windows and never remove the destination as a fallback.
function writeJsonFile(file, value, { bom = false } = {}) {
  const text = (bom ? '\uFEFF' : '') + JSON.stringify(value, null, 2);
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { /* Keep the original write error. */ }
    throw error;
  }
}

module.exports = { assertShape, readJsonFile, writeJsonFile };
