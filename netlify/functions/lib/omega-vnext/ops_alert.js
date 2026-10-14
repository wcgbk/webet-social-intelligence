'use strict';

/**
 * One line on stderr when missing data would otherwise become an empty
 * result. Does not change a price, a gate, or a published card.
 */
function opsAlert(code, detail) {
  const text = detail == null ? '' : String(detail);
  const line = `[omega-ops] ALERT code=${code}${text ? ' ' + text : ''}`;
  console.error(line);
  return { code, detail: text, line };
}

module.exports = { opsAlert };
