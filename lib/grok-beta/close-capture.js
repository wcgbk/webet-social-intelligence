"use strict";

// Stub. Grok Beta does not copy the Alpha CLV observer.
// Future close prices land in grok-beta/closes/{date}.json.

const { writeClosesStub } = require("./store");

async function stubCloseCapture(dateISO, published) {
  const payload = {
    stub: true,
    date: dateISO,
    note: "Close-capture not implemented. Do not read Alpha observer.",
    pickCount: (published && published.picks && published.picks.length) || 0,
    writtenAt: new Date().toISOString(),
  };
  await writeClosesStub(dateISO, payload);
  return payload;
}

module.exports = { stubCloseCapture };
