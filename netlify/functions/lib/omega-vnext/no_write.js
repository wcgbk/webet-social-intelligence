'use strict';

/**
 * OMEGA_REPLAY_NO_WRITE blocks blob and store writes.
 * Truthy values: 1, true, yes, on (any case, surrounding space ignored).
 * Reads are not blocked. The flag is read at call time.
 */
function replayNoWrite(env) {
  const src = env || process.env;
  const raw = src && src.OMEGA_REPLAY_NO_WRITE;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function logBlocked(op) {
  console.log(`[omega-vnext/store] OMEGA_REPLAY_NO_WRITE blocked ${op}`);
}

module.exports = {
  replayNoWrite,
  logBlocked,
};
