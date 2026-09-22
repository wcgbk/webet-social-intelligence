'use strict';
/**
 * capture-omega-lines-late.js — thin second schedule for 9:00 and 9:15 ET.
 * Netlify allows one cron per function. Same handler as capture-omega-lines.
 * 9:30 ET is not scheduled here (races trigger-picks-omega).
 */
module.exports = require('./capture-omega-lines');
