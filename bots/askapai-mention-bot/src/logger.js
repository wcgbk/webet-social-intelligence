/**
 * logger.js — Tiny leveled structured logger.
 * Writes single-line JSON-friendly output so it's greppable and n8n/log-drain safe.
 */

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(require('./config').logLevel || 'info')] || LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg };
  if (meta && Object.keys(meta).length) line.meta = meta;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
