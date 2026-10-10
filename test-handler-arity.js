'use strict';
// Node 24 Lambda rejects handlers with length > 2
// (Runtime.CallbackHandlerDeprecated — the third parameter is the old callback).
// Require every top-level netlify/functions/*.js that exports handler and
// assert handler.length <= 2.
// A file that fails to load only because an env var is missing is skipped
// and reported. Bare third-party modules that are not installed in this
// checkout are replaced with an inert stub so the handler can still be measured.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const dir = path.join(__dirname, 'netlify/functions');
const stubCache = new Map();
const stubbed = [];

function isBareSpecifier(request) {
  return typeof request === 'string'
    && request.length > 0
    && !request.startsWith('.')
    && !request.startsWith('node:')
    && !path.isAbsolute(request);
}

function isMissingEnv(err) {
  if (!err || err.code === 'MODULE_NOT_FOUND') return false;
  const msg = String(err.message || err);
  if (/env var|environment variable|process\.env/i.test(msg)) return true;
  if (/not configured/i.test(msg)) return true;
  if (/\b[A-Z][A-Z0-9_]{3,}\b/.test(msg) && /missing|required|not set|unset|unavailable/i.test(msg)) {
    return true;
  }
  return false;
}

function makeStub() {
  function stub() { return stub; }
  return new Proxy(stub, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === '__esModule') return true;
      if (typeof prop === 'symbol') return target[prop];
      return stub;
    },
  });
}

const realLoad = Module._load;
Module._load = function (request) {
  if (stubCache.has(request)) return stubCache.get(request);
  if (!isBareSpecifier(request)) return realLoad.apply(this, arguments);
  try {
    return realLoad.apply(this, arguments);
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
    const quoted = `'${request}'`;
    if (!String(err.message || '').includes(quoted)) throw err;
    const stub = makeStub();
    stubCache.set(request, stub);
    stubbed.push(request);
    return stub;
  }
};

const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
const checked = [];
const skipped = [];
const failures = [];

for (const name of files) {
  let mod;
  try {
    mod = require(path.join(dir, name));
  } catch (err) {
    if (isMissingEnv(err)) {
      skipped.push({ name, message: String(err && err.message || err).split('\n')[0] });
      continue;
    }
    failures.push(`${name}: require failed: ${err && err.stack ? err.stack : err}`);
    continue;
  }
  if (!mod || typeof mod.handler !== 'function') continue;
  checked.push(name);
  if (mod.handler.length > 2) {
    failures.push(`${name}: handler.length=${mod.handler.length} (max 2; a third parameter is the deprecated Node 24 callback)`);
  }
}

const uniqueStubs = [...new Set(stubbed)].sort();
if (uniqueStubs.length) console.log('stubbed missing modules: ' + uniqueStubs.join(', '));
if (skipped.length) {
  console.log('SKIP missing env:');
  for (const row of skipped) console.log(`  ${row.name}: ${row.message}`);
} else {
  console.log('missing-env skips: 0');
}

if (failures.length) {
  for (const line of failures) console.error(line);
  process.exit(1);
}

assert.ok(checked.includes('get-omega-capture-health.js'));
assert.ok(checked.length > 0, 'expected at least one handler');
console.log(`PASS test-handler-arity checked=${checked.length} skipped-env=${skipped.length}`);
