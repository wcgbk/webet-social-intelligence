'use strict';

/**
 * Private generate-time health blob (omega-health-{date} / omega-health-latest).
 * Deep-clones inputs first so the record cannot mutate picksData.
 */

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function buildHealthRecord(picksData, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const cloned = JSON.parse(JSON.stringify(picksData == null ? {} : picksData));
  const src = plainObject(cloned) || {};

  let captureHealth = null;
  if (Object.prototype.hasOwnProperty.call(options, 'captureHealth')) {
    const copied = JSON.parse(JSON.stringify(options.captureHealth == null ? null : options.captureHealth));
    captureHealth = plainObject(copied);
  } else {
    captureHealth = plainObject(src.captureHealth);
  }

  const qaHardFailList = Array.isArray(src.qaHardFails) ? src.qaHardFails.slice() : [];
  const qaHardFails = qaHardFailList.length;
  const pipeline = plainObject(src.pipelineV2);
  const pipelineV2 = !!(pipeline || src.pipelineV2 === true || (src.meta && src.meta.pipelineV2));
  const fallback = src.fallback === true;
  const writtenAt = typeof options.writtenAt === 'string' && options.writtenAt
    ? options.writtenAt
    : new Date().toISOString();

  return {
    date: src.date || null,
    generatedAt: src.generatedAt || null,
    writtenAt,
    model: src.model || null,
    engine: src.engine || null,
    pipelineV2,
    sportCoverage: src.sportCoverage || null,
    qaHardFails,
    qaHardFailList,
    fallback,
    captureStatus: {
      ok: captureHealth && captureHealth.ok != null ? !!captureHealth.ok : null,
      hardFail: captureHealth ? !!captureHealth.hardFail : false,
      warning: captureHealth && captureHealth.warning != null ? captureHealth.warning : null,
      usableSnapCount: captureHealth && captureHealth.usableSnapCount != null
        ? captureHealth.usableSnapCount
        : null,
      missingSlotsET: captureHealth && Array.isArray(captureHealth.missingSlotsET)
        ? captureHealth.missingSlotsET.slice()
        : [],
    },
    straightCount: Array.isArray(src.picks) ? src.picks.length : 0,
    parlayCount: Array.isArray(src.parlayLegs) ? src.parlayLegs.length : 0,
    pass: pipeline ? pipeline.pass === true : null,
    short: pipeline ? pipeline.short === true : null,
    ok: qaHardFails === 0 && !fallback && !(captureHealth && captureHealth.hardFail),
  };
}

module.exports = { buildHealthRecord };
