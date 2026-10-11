'use strict';

/**
 * Preload for the Omega test harness (node --require).
 *
 * Replaces global fetch so a real request throws unless OMEGA_TEST_ALLOW_NET=1.
 * Tests that assign global.fetch to their own mock never hit this wrapper.
 * http, https, and net connects to a non-local host are blocked the same way,
 * so a module that bypasses fetch still cannot open a socket. Localhost and
 * IPC paths stay open. Each blocked or explicitly allowed remote attempt
 * prints one stderr line:
 *
 *   OMEGA_NET_ATTEMPT <kind> <detail>
 *
 * The harness collects those lines. Query secrets are redacted.
 */

if (global.__omegaTestNetGuard) {
  module.exports = {};
} else {
  global.__omegaTestNetGuard = true;

  const net = require('net');
  const dns = require('dns');

  function allowNet() {
    return String(process.env.OMEGA_TEST_ALLOW_NET || '') === '1';
  }

  function isLocal(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
    if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
    if (h.endsWith('.localhost')) return true;
    return false;
  }

  function redact(detail) {
    let s = String(detail || '');
    s = s.replace(/([?&](?:apiKey|api_key|key|token|access_token|authorization)=)[^&\s]*/gi, '$1[redacted]');
    s = s.replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]');
    if (s.length > 180) s = `${s.slice(0, 180)}…`;
    return s;
  }

  function note(kind, detail) {
    console.error(`OMEGA_NET_ATTEMPT ${kind} ${redact(detail)}`);
  }

  function blockedError(kind, detail) {
    const err = new TypeError(`omega test harness blocked ${kind} ${redact(detail)}`);
    err.code = 'OMEGA_NET_BLOCKED';
    return err;
  }

  const originalFetch = global.fetch;
  if (typeof originalFetch === 'function') {
    const guarded = function omegaGuardedFetch(input, init) {
      let dest = '';
      try {
        if (typeof input === 'string') dest = input;
        else if (input && typeof input.url === 'string') dest = input.url;
        else dest = String(input || '');
      } catch (_) {
        dest = '';
      }
      let host = '';
      try { host = new URL(dest, 'http://localhost').host; } catch (_) { host = ''; }
      if (allowNet() || isLocal(host)) {
        if (!isLocal(host)) note('fetch-allowed', dest);
        return originalFetch.call(global, input, init);
      }
      note('fetch', dest || host || 'unknown');
      return Promise.reject(blockedError('fetch', dest || 'unknown'));
    };
    Object.defineProperty(guarded, 'length', { value: originalFetch.length });
    global.fetch = guarded;
    globalThis.fetch = guarded;
  }

  function hostFromArgs(args) {
    const first = args[0];
    if (typeof first === 'number') {
      return typeof args[1] === 'string' ? args[1] : 'localhost';
    }
    if (typeof first === 'string') {
      if (first.startsWith('/')) return 'localhost';
      try { return new URL(first).host; } catch (_) { return first; }
    }
    if (first instanceof URL) return first.host;
    if (first && typeof first === 'object') {
      if (first.path && !first.host && !first.hostname && first.port == null) return 'localhost';
      return first.hostname || first.host || '';
    }
    return '';
  }

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function omegaGuardedConnect(...args) {
    const host = hostFromArgs(args);
    if (allowNet() || isLocal(host)) {
      if (allowNet() && !isLocal(host)) note('connect-allowed', host);
      return origConnect.apply(this, args);
    }
    note('connect', host || 'unknown');
    const err = blockedError('connect', host || 'unknown');
    process.nextTick(() => {
      this.destroy(err);
    });
    return this;
  };

  function wrapLookup(orig, promiseApi) {
    return function omegaGuardedLookup(hostname, options, callback) {
      let cb = callback;
      let opts = options;
      if (typeof options === 'function') {
        cb = options;
        opts = undefined;
      }
      if (allowNet() || isLocal(hostname)) {
        if (allowNet() && !isLocal(hostname)) note('dns-allowed', hostname);
        if (promiseApi && typeof cb !== 'function') return orig.call(this, hostname, opts);
        return orig.call(this, hostname, opts, cb);
      }
      note('dns', hostname);
      const err = blockedError('dns', hostname);
      if (typeof cb === 'function') {
        process.nextTick(() => cb(err));
        return undefined;
      }
      return Promise.reject(err);
    };
  }

  dns.lookup = wrapLookup(dns.lookup, false);
  if (dns.promises && typeof dns.promises.lookup === 'function') {
    dns.promises.lookup = wrapLookup(dns.promises.lookup, true);
  }

  module.exports = { isLocal };
}
