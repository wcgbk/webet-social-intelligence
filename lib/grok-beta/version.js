"use strict";

function getVersion() {
  const sha = process.env.COMMIT_REF || process.env.GIT_SHA || process.env.HEAD_SHA || "dev";
  return `grok-beta-0.1.0+${String(sha).replace(/^v/, "").slice(0, 7)}`;
}

module.exports = { getVersion, MODEL_ID: "grok-beta", MODEL_SEMVER: "0.1.0" };
