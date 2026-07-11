/**
 * store.js — Durable JSON persistence for bot state + usage.
 *
 * File-based by default (atomic write via temp + rename). Swap this module for
 * Netlify Blobs / Redis / Postgres without touching callers — the interface is
 * just load(path)/save(path, obj).
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function ensureDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function load(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function save(filePath, obj) {
  await ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, filePath); // atomic on POSIX
}

// Synchronous load used only at cold start where async is awkward.
function loadSync(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

module.exports = { load, save, loadSync };
