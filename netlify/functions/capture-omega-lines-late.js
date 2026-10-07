'use strict';
/**
 * capture-omega-lines-late.js — thin second schedule for 9:00 and 9:15 ET.
 * Netlify allows one cron per function. Same capture as capture-omega-lines,
 * guarded under this function name so 6:00/7:30 do not run here.
 * 9:30 ET is not scheduled here (races trigger-picks-omega).
 */
const lines = require('./capture-omega-lines');

exports.handler = (event) => lines.handleCapture(event, 'capture-omega-lines-late');
exports.ALLOWED_UTC_HHMM = lines.ALLOWED_UTC_HHMM;
exports.etSlotLabel = lines.etSlotLabel;
exports.nearestAllowedSlot = lines.nearestAllowedSlot;
