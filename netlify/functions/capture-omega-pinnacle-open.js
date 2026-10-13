'use strict';

/**
 * capture-omega-pinnacle-open.js — hourly free /events discovery.
 *
 * Every ET hour at :00. A sport with a new event id gets one Pinnacle
 * open pull. An open already stored is not pulled again. Does not write
 * the published card. 3:00 / 9:00 / 10:30 checks live on
 * capture-omega-pinnacle-lines.
 */

const lines = require('./capture-omega-pinnacle-lines');

exports.handler = (event) => lines.handleCapture(event, 'capture-omega-pinnacle-open');
