"use strict";

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = "grok-beta";

function baseUrl() {
  return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`;
}
function authHeaders() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function put(key, body, contentType) {
  const auth = authHeaders();
  if (!auth) {
    console.error("[grok-beta] NETLIFY_AUTH_TOKEN missing — cannot write", key);
    return false;
  }
  const isString = typeof body === "string";
  const resp = await fetch(`${baseUrl()}/${key}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": contentType || (isString ? "text/plain" : "application/json") },
    body: isString ? body : JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`[grok-beta] PUT ${key} failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

async function getJson(key) {
  const auth = authHeaders();
  if (!auth) return null;
  try {
    const resp = await fetch(`${baseUrl()}/${key}`, { headers: auth });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function getText(key) {
  const auth = authHeaders();
  if (!auth) return null;
  try {
    const resp = await fetch(`${baseUrl()}/${key}`, { headers: auth });
    if (!resp.ok) return null;
    return (await resp.text()).trim();
  } catch (e) {
    return null;
  }
}

async function sdkGet(key, asJson) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(STORE_NAME);
    return asJson ? await store.get(key, { type: "json" }) : await store.get(key);
  } catch (e) {
    return asJson ? getJson(key) : getText(key);
  }
}

async function writeOddsSnapshot(dateISO, ts, payload) {
  return put(`odds/${dateISO}/${ts}`, payload);
}
async function writeCandidates(dateISO, payload) {
  return put(`candidates/${dateISO}.json`, payload);
}
async function writePublished(dateISO, payload) {
  const ok = await put(`published/${dateISO}.json`, payload);
  await put("latest-date", dateISO, "text/plain");
  return ok;
}
async function writeStatus(payload) {
  return put("status/latest.json", payload);
}
async function writeClosesStub(dateISO, payload) {
  return put(`closes/${dateISO}.json`, payload);
}

async function readPublished(dateISO) {
  const viaSdk = await sdkGet(`published/${dateISO}.json`, true);
  if (viaSdk) return viaSdk;
  return getJson(`published/${dateISO}.json`);
}
async function readLatestDate() {
  const viaSdk = await sdkGet("latest-date", false);
  if (viaSdk) return String(viaSdk).trim();
  return getText("latest-date");
}
async function readStatus() {
  const viaSdk = await sdkGet("status/latest.json", true);
  if (viaSdk) return viaSdk;
  return getJson("status/latest.json");
}

module.exports = {
  STORE_NAME, SITE_ID,
  put, getJson, getText,
  writeOddsSnapshot, writeCandidates, writePublished, writeStatus, writeClosesStub,
  readPublished, readLatestDate, readStatus,
};
