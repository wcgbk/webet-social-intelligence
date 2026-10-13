'use strict';

/**
 * capture-omega-pinnacle-open.js — suspended.
 *
 * Openers are the first price in the 3:00 ET pull. This handler returns
 * before any Odds API call. 3:00 and 10:00 checks live on
 * capture-omega-pinnacle-lines.
 */

const lines = require('./capture-omega-pinnacle-lines');

exports.handler = (event) => lines.handleCapture(event, 'capture-omega-pinnacle-open');
