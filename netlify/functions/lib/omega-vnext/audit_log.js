'use strict';

/**
 * One audit log per Omega run.
 * Every outbound HTTP pull, model call, and blob call recorded here gets
 * ts (ISO UTC), seq, provider, and a URL with secrets removed.
 * Authorization headers are never stored. No pricing inputs live on the log.
 *
 * Absent a current-run log, resolveFetch and auditBlobCall are pass-throughs.
 */

const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { replayNoWrite } = require('./no_write');

const als = new AsyncLocalStorage();

const PROVIDERS = new Set([
  'odds-api', 'espn', 'nws', 'polymarket', 'kalshi', 'xai', 'x-api', 'netlify-blobs', 'other',
]);
const KINDS = new Set(['http', 'model', 'blob']);
const SECRET_PARAM = '(?:api[_-]?key|access_token|token|key)';

function makeRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function currentAudit() {
  return als.getStore() || null;
}

function runWithAudit(log, fn) {
  if (!log) return fn();
  return als.run(log, fn);
}

function providerFromUrl(url) {
  const s = String(url || '').toLowerCase();
  if (s.includes('the-odds-api.com')) return 'odds-api';
  if (s.includes('espn.com')) return 'espn';
  if (s.includes('weather.gov')) return 'nws';
  if (s.includes('polymarket.com')) return 'polymarket';
  if (s.includes('kalshi.com')) return 'kalshi';
  if (s.includes('api.x.ai')) return 'xai';
  if (s.includes('api.x.com') || s.includes('api.twitter.com')) return 'x-api';
  if (s.includes('netlify-blobs:') || s.includes('/blobs/') || s.includes('api.netlify.com')) return 'netlify-blobs';
  return 'other';
}

function normalizeProvider(name, url) {
  const raw = name || providerFromUrl(url);
  return PROVIDERS.has(raw) ? raw : 'other';
}

function redactUrl(url) {
  try {
    return String(url == null ? '' : url).replace(
      new RegExp(`([?&#]${SECRET_PARAM}=)[^&#\\s]*`, 'gi'),
      '$1REDACTED',
    );
  } catch (_) {
    return '';
  }
}

function secretValuesFromUrl(url) {
  const out = [];
  try {
    const re = new RegExp(`[?&#]${SECRET_PARAM}=([^&#\\s]*)`, 'gi');
    const s = String(url || '');
    let m;
    while ((m = re.exec(s))) {
      if (!m[1] || m[1] === 'REDACTED') continue;
      out.push(m[1]);
      try {
        const decoded = decodeURIComponent(m[1]);
        if (decoded && decoded !== m[1]) out.push(decoded);
      } catch (_) { /* keep the raw value */ }
    }
  } catch (_) { /* no secrets extracted */ }
  return out;
}

function scrubText(text, secrets) {
  let s = redactUrl(text == null ? '' : text);
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer REDACTED');
  s = s.replace(/Authorization:\s*\S+/gi, 'Authorization REDACTED');
  for (const secret of secrets || []) {
    const value = String(secret || '');
    if (value.length < 6 || value === 'REDACTED') continue;
    s = s.split(value).join('REDACTED');
  }
  return s;
}

function headerValue(resp, name) {
  if (!resp || resp.headers == null) return null;
  const h = resp.headers;
  const want = String(name || '').toLowerCase();
  try {
    if (typeof h.get === 'function') {
      const direct = h.get(name);
      if (direct != null && direct !== '') return Array.isArray(direct) ? direct[0] : direct;
      const lower = h.get(want);
      if (lower != null && lower !== '') return Array.isArray(lower) ? lower[0] : lower;
    }
  } catch (_) { /* mock headers */ }
  if (typeof h === 'object') {
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === want && h[k] != null && h[k] !== '') {
        return Array.isArray(h[k]) ? h[k][0] : h[k];
      }
    }
  }
  return null;
}

function headerNumber(resp, name) {
  const raw = headerValue(resp, name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : String(raw);
}

function responseBytes(resp) {
  const raw = headerValue(resp, 'content-length');
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function responseOk(resp) {
  if (!resp) return false;
  if (typeof resp.ok === 'boolean') return resp.ok;
  const status = Number(resp.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

function statusOf(respOrErr) {
  if (respOrErr == null || respOrErr.status == null || respOrErr.status === '') return null;
  const n = Number(respOrErr.status);
  return Number.isFinite(n) ? n : null;
}

function tokenFields(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const prompt = num(tokens.prompt != null ? tokens.prompt : tokens.prompt_tokens);
  const completion = num(tokens.completion != null ? tokens.completion : tokens.completion_tokens);
  const total = num(tokens.total != null ? tokens.total : tokens.total_tokens);
  if (prompt == null && completion == null && total == null) return null;
  return { prompt, completion, total };
}

function safeSegment(value, fallback) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return cleaned || fallback;
}

function auditBlobKey(date, runId) {
  return `omega-audit/${safeSegment(date, 'nodate')}/${safeSegment(runId, 'run')}`;
}

function createAuditLog({ runId, date, fn } = {}) {
  const id = runId || makeRunId();
  const day = date || null;
  const name = fn || null;
  const list = [];
  let seq = 0;

  function record(entry) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const originalUrl = src.url == null ? '' : String(src.url);
    const secrets = secretValuesFromUrl(originalUrl).concat(Array.isArray(src._secrets) ? src._secrets : []);
    const provider = normalizeProvider(src.provider, originalUrl);
    const kind = KINDS.has(src.kind) ? src.kind : (provider === 'netlify-blobs' ? 'blob' : 'http');
    const row = {
      ts: src.ts || new Date().toISOString(),
      seq: ++seq,
      kind,
      provider,
      method: String(src.method || 'GET').toUpperCase(),
      url: redactUrl(originalUrl),
      status: src.status == null || src.status === '' ? null : (Number.isFinite(Number(src.status)) ? Number(src.status) : null),
      ms: Number.isFinite(Number(src.ms)) ? Number(src.ms) : null,
      bytes: src.bytes == null || src.bytes === '' ? null : (Number.isFinite(Number(src.bytes)) ? Number(src.bytes) : null),
      ok: !!src.ok,
      error: src.error == null || src.error === '' ? null : scrubText(src.error, secrets),
    };
    if (provider === 'odds-api') {
      row['x-requests-last'] = src['x-requests-last'] == null ? null : src['x-requests-last'];
      row['x-requests-remaining'] = src['x-requests-remaining'] == null ? null : src['x-requests-remaining'];
    }
    if (kind === 'model' || src.model != null || src.modelAnswered != null || src.attempt != null) {
      row.model = src.model == null ? null : String(src.model);
      row.modelAnswered = src.modelAnswered == null || src.modelAnswered === '' ? null : String(src.modelAnswered);
      row.attempt = src.attempt == null || src.attempt === '' ? null : Number(src.attempt);
      row.tokens = tokenFields(src.tokens);
    }
    // URL was redacted above. Scrub any leftover secret value that survived in the URL or error.
    row.url = scrubText(row.url, secrets);
    if (row.error) row.error = scrubText(row.error, secrets);
    if (src.note != null && src.note !== '') {
      row.note = scrubText(String(src.note), secrets).slice(0, 400);
    }
    list.push(row);
    return row;
  }

  function safeRecord(entry) {
    try { return record(entry); }
    catch (err) {
      console.error(`[omega-audit] record soft-fail: ${err && err.message}`);
      return null;
    }
  }

  function wrapFetch(fetchImpl, meta) {
    const impl = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    if (impl && impl.__omegaAuditWrapped) return impl;
    const fixed = meta && typeof meta === 'object' ? meta : {};
    async function omegaAuditedFetch(url, init) {
      const started = Date.now();
      const method = (init && init.method) || fixed.method || 'GET';
      const provider = normalizeProvider(fixed.provider, url);
      const kind = KINDS.has(fixed.kind) ? fixed.kind : (provider === 'netlify-blobs' ? 'blob' : 'http');
      const base = {
        kind,
        provider,
        method,
        url,
        model: fixed.model,
        attempt: fixed.attempt,
      };
      try {
        const resp = await impl(url, init);
        const ok = responseOk(resp);
        const status = statusOf(resp);
        const entry = {
          ...base,
          status,
          ms: Date.now() - started,
          bytes: responseBytes(resp),
          ok,
          error: ok ? null : `HTTP ${status != null ? status : 'error'}`,
        };
        if (provider === 'odds-api') {
          entry['x-requests-last'] = headerNumber(resp, 'x-requests-last');
          entry['x-requests-remaining'] = headerNumber(resp, 'x-requests-remaining');
        }
        safeRecord(entry);
        return resp;
      } catch (err) {
        const entry = {
          ...base,
          status: statusOf(err),
          ms: Date.now() - started,
          bytes: null,
          ok: false,
          error: (err && err.message) || 'fetch failed',
        };
        if (provider === 'odds-api') {
          entry['x-requests-last'] = null;
          entry['x-requests-remaining'] = null;
        }
        safeRecord(entry);
        throw err;
      }
    }
    Object.defineProperty(omegaAuditedFetch, '__omegaAuditWrapped', { value: true });
    return omegaAuditedFetch;
  }

  function summary() {
    const byProvider = {};
    const models = [];
    const errors = [];
    for (const e of list) {
      const p = e.provider || 'other';
      byProvider[p] = (byProvider[p] || 0) + 1;
      if (e.kind === 'model') {
        models.push({
          model: e.model,
          modelAnswered: e.modelAnswered,
          attempt: e.attempt,
          ok: e.ok,
          status: e.status,
        });
      }
      if (!e.ok) {
        errors.push({
          seq: e.seq,
          provider: e.provider,
          kind: e.kind,
          status: e.status,
          error: e.error,
        });
      }
    }
    return {
      runId: id,
      count: list.length,
      byProvider,
      models,
      errors,
    };
  }

  return {
    runId: id,
    date: day,
    fn: name,
    record: safeRecord,
    wrapFetch,
    entries() { return list.slice(); },
    summary,
  };
}

function resolveFetch(fetchImpl, meta) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const log = als.getStore();
  if (!log || typeof log.wrapFetch !== 'function') return impl;
  return log.wrapFetch(impl, meta);
}

/**
 * SDK blob op. REST fallbacks go through resolveFetch instead, so a failed
 * SDK attempt and the REST retry are two entries. No log: fn() unchanged.
 */
async function auditBlobCall(method, key, fn) {
  const log = als.getStore();
  if (!log) return fn();
  const started = Date.now();
  const url = `netlify-blobs://${key}`;
  try {
    const result = await fn();
    try {
      log.record({
        kind: 'blob',
        provider: 'netlify-blobs',
        method: method || 'GET',
        url,
        status: 200,
        ms: Date.now() - started,
        bytes: null,
        ok: true,
        error: null,
      });
    } catch (err) {
      console.error(`[omega-audit] record soft-fail: ${err && err.message}`);
    }
    return result;
  } catch (err) {
    try {
      log.record({
        kind: 'blob',
        provider: 'netlify-blobs',
        method: method || 'GET',
        url,
        status: statusOf(err),
        ms: Date.now() - started,
        bytes: null,
        ok: false,
        error: (err && err.message) || 'blob failed',
      });
    } catch (logErr) {
      console.error(`[omega-audit] record soft-fail: ${logErr && logErr.message}`);
    }
    throw err;
  }
}

/**
 * Compact summary merged onto the card. Existing hash-audit fields stay.
 * Pick odds, units, and probabilities are not read or written.
 */
function attachAuditSummary(card, log) {
  if (!card || typeof card !== 'object' || !log || typeof log.summary !== 'function') return card;
  try {
    const summary = log.summary();
    const prev = card.audit && typeof card.audit === 'object' && !Array.isArray(card.audit) ? card.audit : {};
    card.audit = { ...prev, ...summary };
  } catch (err) {
    console.error(`[omega-audit] attach soft-fail: ${err && err.message}`);
  }
  return card;
}

function auditFilePath() {
  const file = process.env.OMEGA_AUDIT_FILE;
  if (file == null) return '';
  const trimmed = String(file).trim();
  return trimmed;
}

function appendAuditFile(payload) {
  const file = auditFilePath();
  if (!file) return null;
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
  return file;
}

/**
 * Full entries at omega-audit/<date>/<runId>.
 * dryRun or OMEGA_REPLAY_NO_WRITE skips the blob. OMEGA_AUDIT_FILE then
 * receives one JSONL line for the run.
 */
async function persistAuditLog(log, opts = {}) {
  if (!log) return { wrote: false, reason: 'no-log', key: null, file: null };
  const payload = {
    runId: log.runId,
    date: log.date || null,
    fn: log.fn || null,
    summary: typeof log.summary === 'function' ? log.summary() : null,
    entries: typeof log.entries === 'function' ? log.entries() : [],
  };
  const noBlob = !!(opts.dryRun || replayNoWrite());
  if (noBlob) {
    const file = appendAuditFile(payload);
    return { wrote: false, reason: opts.dryRun ? 'dryRun' : 'no-write', key: null, file };
  }
  const key = auditBlobKey(log.date, log.runId);
  const storeJson = opts.storeJson || require('./store').storeJson;
  await storeJson(key, payload);
  return { wrote: true, key, file: null };
}

module.exports = {
  createAuditLog,
  runWithAudit,
  currentAudit,
  resolveFetch,
  persistAuditLog,
  attachAuditSummary,
  auditBlobCall,
  makeRunId,
  providerFromUrl,
  redactUrl,
  auditBlobKey,
};
