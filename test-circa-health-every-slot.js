#!/usr/bin/env node
// Offline Circa checks: every health slot writes a snapshot, skipOdds never
// calls the Odds API, and sourceUrl is limited to the official contest PDF.
// No network. fetch and Date are mocked.
"use strict";

const assert = require("assert");
const { circaCronSlot, resolveContestWeek } = require("./netlify/functions/lib/circa-contest");
const health = require("./netlify/functions/lib/circa-card-health");
const checker = require("./netlify/functions/check-circa-card-health");
const gen = require("./netlify/functions/generate-picks-circa-background");

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("  FAIL " + name + ": " + (e && e.stack ? e.stack : e));
  }
}

const FOLLOW = {
  first: "first-check",
  refresh: "refresh-check",
  final: "final-check",
  "holiday-first": "holiday-check",
};

function freezeNow(iso) {
  const RealDate = Date;
  class Frozen extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(iso);
      else super(...args);
    }
    static now() {
      return new RealDate(iso).getTime();
    }
  }
  global.Date = Frozen;
  return () => {
    global.Date = RealDate;
  };
}

function jsonish(status, data, extra) {
  const body = data == null ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => (extra && extra.type) || "application/json" },
    json: async () => data,
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}

function deadFetch() {
  const calls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: (opts.method || "GET").toUpperCase(), body: opts.body });
    return jsonish(404, {});
  };
  return {
    calls,
    restore() {
      global.fetch = prev;
    },
  };
}

async function withLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.map((x) => String(x)).join(" "));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = orig;
  }
}

(async () => {
  await check("circaHealthCronSlot matches every circaCronSlot generate window", async () => {
    const samples = [
      "2026-09-10T17:15:00Z",
      "2026-09-17T17:30:00Z",
      "2026-09-17T17:45:00Z",
      "2026-09-17T18:00:00Z",
      "2026-09-17T17:04:00Z",
      "2026-09-11T17:00:00Z",
      "2026-09-11T17:15:00Z",
      "2026-09-11T17:30:00Z",
      "2026-09-11T17:45:00Z",
      "2026-09-11T16:50:00Z",
      "2026-09-12T20:00:00Z",
      "2026-09-12T19:50:00Z",
      "2026-11-25T17:15:00Z",
      "2026-11-25T17:04:00Z",
    ];
    for (const iso of samples) {
      const now = new Date(iso);
      const genSlot = circaCronSlot(now);
      assert.ok(genSlot, iso + " should be a generate slot");
      const slot = health.circaHealthCronSlot(now);
      const ok = slot === genSlot || slot === FOLLOW[genSlot];
      assert.ok(ok, iso + " health=" + slot + " generate=" + genSlot);
    }
    // Inside generate slack but outside the +5min follow-up window: use the generate name.
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-17T17:04:00Z")), "first");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-11T16:50:00Z")), "refresh");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-12T19:50:00Z")), "final");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-11-25T17:04:00Z")), "holiday-first");
    // Existing follow-up names stay.
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-24T17:20:00Z")), "first-check");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-25T17:05:00Z")), "refresh-check");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-26T20:05:00Z")), "final-check");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-11-25T17:20:00Z")), "holiday-check");
    assert.strictEqual(health.circaHealthCronSlot(new Date("2026-09-22T12:00:00Z")), null);
  });

  await check("off-window invocation writes a snapshot", async () => {
    const iso = "2026-10-22T12:00:00Z";
    const week = resolveContestWeek(new Date(iso));
    assert.strictEqual(health.circaHealthCronSlot(new Date(iso)), null);
    assert.ok(!week.preSeason && !week.postSeason);
    const card = {
      week: week.week,
      weekNum: week.weekNum,
      pending: false,
      error: false,
      lineSource: "circa-contest-pdf",
      fromFixture: false,
      sourceUrl: "https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf",
      picks: [{}, {}, {}, {}, {}],
    };
    const calls = [];
    const prevFetch = global.fetch;
    const prevTok = process.env.NETLIFY_AUTH_TOKEN;
    process.env.NETLIFY_AUTH_TOKEN = "offline-test-token";
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      calls.push({ url: String(url), method, body: opts.body });
      if (method === "PUT") return jsonish(200, { ok: true });
      return jsonish(200, card);
    };
    const unfreeze = freezeNow(iso);
    try {
      const res = await checker.handler({ httpMethod: "POST", body: "{}" });
      const parsed = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(parsed.slot, "off-window");
      assert.strictEqual(parsed.health.slot, "off-window");
      assert.strictEqual(parsed.health.status, "ok");
      assert.strictEqual(parsed.health.picksCount, 5);
      assert.strictEqual(parsed.health.week, week.week);
      assert.strictEqual(parsed.health.persisted.latest, true);
      assert.strictEqual(parsed.health.persisted.dated, true);
      assert.strictEqual(parsed.health.persisted.alert, false);
      const puts = calls.filter((c) => c.method === "PUT");
      assert.ok(puts.length >= 2, "expected latest + dated PUTs");
      assert.ok(puts.every((c) => JSON.parse(c.body).slot === "off-window"));
      assert.ok(calls.some((c) => c.method === "GET"), "card should be read");
    } finally {
      unfreeze();
      global.fetch = prevFetch;
      if (prevTok == null) delete process.env.NETLIFY_AUTH_TOKEN;
      else process.env.NETLIFY_AUTH_TOKEN = prevTok;
    }
  });

  await check("out of season still skips with no health write", async () => {
    const calls = [];
    const prevFetch = global.fetch;
    const prevTok = process.env.NETLIFY_AUTH_TOKEN;
    process.env.NETLIFY_AUTH_TOKEN = "offline-test-token";
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: (opts.method || "GET").toUpperCase() });
      return jsonish(200, {});
    };
    const unfreeze = freezeNow("2026-08-01T16:00:00Z");
    try {
      const res = await checker.handler({ httpMethod: "POST", body: "{}" });
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.skipped, "outside NFL season");
      assert.strictEqual(calls.length, 0);
    } finally {
      unfreeze();
      global.fetch = prevFetch;
      if (prevTok == null) delete process.env.NETLIFY_AUTH_TOKEN;
      else process.env.NETLIFY_AUTH_TOKEN = prevTok;
    }
  });

  await check("REST PUT failure falls back to getStore().set()", async () => {
    const blobsId = require.resolve("@netlify/blobs");
    const previous = require.cache[blobsId];
    const sets = [];
    require.cache[blobsId] = {
      id: blobsId,
      filename: blobsId,
      loaded: true,
      exports: {
        getStore(name) {
          return {
            async set(key, data) {
              sets.push({ name, key, data });
            },
          };
        },
      },
    };
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.map((x) => String(x)).join(" "));
    const prevTok = process.env.NETLIFY_AUTH_TOKEN;
    const prevFetch = global.fetch;
    process.env.NETLIFY_AUTH_TOKEN = "offline-test-token";
    global.fetch = async () => {
      throw new Error("rest down");
    };
    try {
      const out = await health.writeCircaCardHealth({
        status: "error",
        errorCode: "circa-card-pending",
        errorMessage: "pending",
        weekNum: 7,
        week: "2026-W07",
        picksCount: 0,
        slot: "first",
        source: "test",
      });
      assert.strictEqual(out.persisted.latest, true);
      assert.strictEqual(out.persisted.dated, true);
      assert.strictEqual(out.persisted.alert, true);
      assert.ok(sets.length >= 3);
      assert.ok(sets.every((s) => s.name === "edge-picks-circa"));
      assert.ok(errors.some((e) => /Blob PUT/.test(e) && /rest down/.test(e)));

      sets.length = 0;
      errors.length = 0;
      let fetches = 0;
      delete process.env.NETLIFY_AUTH_TOKEN;
      global.fetch = async () => {
        fetches++;
        throw new Error("should not REST without a token");
      };
      const okSnap = await health.writeCircaCardHealth({
        status: "ok",
        weekNum: 7,
        week: "2026-W07",
        picksCount: 5,
        slot: "off-window",
        source: "test",
      });
      assert.strictEqual(fetches, 0);
      assert.strictEqual(okSnap.persisted.latest, true);
      assert.strictEqual(okSnap.persisted.dated, true);
      assert.strictEqual(okSnap.persisted.alert, false);
      assert.ok(errors.some((e) => /NETLIFY_AUTH_TOKEN missing/.test(e)));
      assert.ok(sets.length >= 2);
    } finally {
      console.error = origErr;
      global.fetch = prevFetch;
      if (previous) require.cache[blobsId] = previous;
      else delete require.cache[blobsId];
      if (prevTok == null) delete process.env.NETLIFY_AUTH_TOKEN;
      else process.env.NETLIFY_AUTH_TOKEN = prevTok;
    }
  });

  await check("skipOdds does not call fetchNFLSpreadOdds", async () => {
    const prevOdds = process.env.ODDS_API_KEY;
    const prevSpreads = process.env.CIRCA_SPREADS_URL;
    process.env.ODDS_API_KEY = "offline-test-key";
    delete process.env.CIRCA_SPREADS_URL;
    const net = deadFetch();
    const unfreeze = freezeNow("2026-09-10T15:00:00Z");
    try {
      const skipped = await withLogs(() => gen.handler({
        httpMethod: "POST",
        body: JSON.stringify({ dryRun: true, week: "2026-W01", skipOdds: true }),
      }));
      const oddsCalls = net.calls.filter((c) => /the-odds-api\.com/.test(c.url));
      assert.strictEqual(oddsCalls.length, 0);
      assert.ok(skipped.logs.some((l) => l.includes("[circa] skipOdds — no Odds API call; ratings-only vs Circa PDF")));
      const body = JSON.parse(skipped.value.body);
      const picks = (body.picksData && body.picksData.picks) || [];
      assert.ok(picks.length >= 1, "expected a ratings-only card");
      assert.ok(picks.every((p) => p.lineSource === "circa-contest-pdf"));
      assert.ok(picks.every((p) => p.marketSpread == null));
      assert.strictEqual(body.picksData.lineSource, "circa-contest-pdf");

      net.calls.length = 0;
      const control = await withLogs(() => gen.handler({
        httpMethod: "POST",
        body: JSON.stringify({ dryRun: true, week: "2026-W01", skipOdds: false }),
      }));
      const controlOdds = net.calls.filter((c) => /the-odds-api\.com/.test(c.url));
      assert.ok(controlOdds.length >= 1, "control run should request Odds API (mocked)");
      assert.ok(!control.logs.some((l) => l.includes("skipOdds — no Odds API call")));
    } finally {
      unfreeze();
      net.restore();
      if (prevOdds == null) delete process.env.ODDS_API_KEY;
      else process.env.ODDS_API_KEY = prevOdds;
      if (prevSpreads == null) delete process.env.CIRCA_SPREADS_URL;
      else process.env.CIRCA_SPREADS_URL = prevSpreads;
    }
  });

  await check("bad sourceUrl is rejected and never fetched", async () => {
    const prevSpreads = process.env.CIRCA_SPREADS_URL;
    const prevOdds = process.env.ODDS_API_KEY;
    delete process.env.CIRCA_SPREADS_URL;
    delete process.env.ODDS_API_KEY;
    const badUrls = [
      "https://evil.example/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf",
      "http://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf",
      "https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf?x=1",
      "https://circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf",
      "https://www.circasports.com/wp-content/uploads/2026/10/Other-Sheet-Week-7.pdf",
      "file:///tmp/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf",
    ];
    const net = deadFetch();
    const unfreeze = freezeNow("2026-09-10T15:00:00Z");
    try {
      for (const sourceUrl of badUrls) {
        net.calls.length = 0;
        const ran = await withLogs(() => gen.handler({
          httpMethod: "POST",
          body: JSON.stringify({ dryRun: true, week: "2026-W01", skipOdds: true, sourceUrl }),
        }));
        assert.ok(!net.calls.some((c) => c.url === sourceUrl || c.url.startsWith(sourceUrl)));
        assert.ok(ran.logs.some((l) => /ignoring sourceUrl/.test(l)), "expected ignore log for " + sourceUrl);
        const picks = JSON.parse(ran.value.body).picksData.picks || [];
        assert.ok(picks.every((p) => p.lineSource === "circa-contest-pdf"));
      }

      const good = "https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-7.pdf";
      net.calls.length = 0;
      const accepted = await withLogs(() => gen.handler({
        httpMethod: "POST",
        body: JSON.stringify({ dryRun: true, week: "2026-W01", skipOdds: true, sourceUrl: good }),
      }));
      assert.ok(net.calls.some((c) => c.url === good), "official sourceUrl should be fetched");
      assert.ok(!accepted.logs.some((l) => /ignoring sourceUrl/.test(l)));
      assert.ok(!net.calls.some((c) => /the-odds-api\.com/.test(c.url)));
    } finally {
      unfreeze();
      net.restore();
      if (prevSpreads == null) delete process.env.CIRCA_SPREADS_URL;
      else process.env.CIRCA_SPREADS_URL = prevSpreads;
      if (prevOdds == null) delete process.env.ODDS_API_KEY;
      else process.env.ODDS_API_KEY = prevOdds;
    }
  });

  if (failed) {
    console.error("\n" + failed + " check(s) failed");
    process.exit(1);
  }
  console.log("\nall circa health-every-slot checks passed");
})();
