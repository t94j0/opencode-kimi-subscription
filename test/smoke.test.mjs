// Structural + behavioral smoke test — no network, no credentials required.
// Verifies the plugin self-registers its provider, reads discovered models
// from the on-disk cache, and (with a stubbed global fetch) drives the real
// request path: auth-header injection, temperature pinning, and the
// refresh-and-retry-once behavior on an upstream 401.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";

// Point the model cache at a throwaway file BEFORE importing the plugin (the
// cache path is resolved at module load).
const CACHE = join(tmpdir(), `kimi-smoke-${process.pid}.json`);
process.env.KIMI_SUBSCRIPTION_CACHE = CACHE;
const DATA = join(tmpdir(), `kimi-smoke-data-${process.pid}`);
process.env.XDG_DATA_HOME = DATA;
const AUTH_FILE = join(DATA, "opencode", "auth.json");
mkdirSync(join(DATA, "opencode"), { recursive: true });
after(() => rmSync(DATA, { recursive: true, force: true }));
const mod = await import("../dist/index.js");
const { KimiCodePlugin } = mod;

after(() => rmSync(CACHE, { force: true }));

// Fresh mock client per test; records everything the plugin sends it.
function makeClient() {
  const calls = { logs: [], toasts: [], authSet: [] };
  const client = {
    auth: { set: async ({ path, body }) => (calls.authSet.push({ path, body }), true) },
    app: { log: async (o) => (calls.logs.push(o.body), true) },
    tui: { showToast: async (o) => (calls.toasts.push(o.body), true) },
  };
  return { client, calls };
}

// log/toast are fire-and-forget (microtask-deferred); let them settle.
const settle = () => new Promise((r) => setImmediate(r));

// Seed a fresh model cache so the loader's fire-and-forget /models sync
// short-circuits instead of hitting the stubbed fetch mid-test.
const seedFreshCache = () => writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), models: [{ id: "k3" }] }));

// Stub globalThis.fetch, routing BY URL — never by call order (the model-sync
// fetch would make call counts nondeterministic). Restored automatically.
function stubFetch(t, routes) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [substring, handler] of routes) {
      if (url.includes(substring)) return handler(init, calls);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return calls;
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FRESH_AUTH = () => ({ type: "oauth", access: "AAA", refresh: "RRR", expires: Date.now() + 3_600_000 });
const STALE_AUTH = () => ({ type: "oauth", access: "OLD", refresh: "RRR", expires: Date.now() + 60_000 });
const REFRESH_OK = { access_token: "NEW", refresh_token: "NEWR", expires_in: 900 };
const API_URL = "https://api.kimi.com/coding/v1/chat/completions";

test("failed credential persistence rejects the request without reporting refresh success", async (t) => {
  seedFreshCache();
  const { client, calls } = makeClient();
  let saves = 0;
  client.auth = createOpencodeClient({
    baseUrl: "http://opencode.test",
    fetch: async () => {
      saves++;
      return jsonResponse(500, { name: "UnknownError", data: { message: "credential write failed" } });
    },
  }).auth;
  const requests = stubFetch(t, [["/api/oauth/token", () => jsonResponse(200, REFRESH_OK)]]);
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => STALE_AUTH());
  await assert.rejects(pluginFetch(API_URL, { method: "POST" }), /credential write failed/);
  assert.equal(saves, 1);
  assert.equal(requests.length, 1, "only token refresh is sent; no completion with unsaved credentials");
  await settle();
  assert.ok(calls.logs.some((l) => l.message === "token refresh failed"));
  assert.ok(calls.logs.every((l) => l.message !== "access token refreshed"));
});

test("startup uses discovered models even when the cache cannot be written", async (t) => {
  rmSync(CACHE, { force: true });
  mkdirSync(CACHE); // A directory at the cache file path makes writes fail on every platform.
  t.after(() => rmSync(CACHE, { recursive: true, force: true }));
  writeFileSync(AUTH_FILE, JSON.stringify({ "kimi-code": FRESH_AUTH() }));
  t.after(() => rmSync(AUTH_FILE, { force: true }));
  stubFetch(t, [["/models", () => jsonResponse(200, { data: [{ id: "live-model", context_length: 1048576 }] })]]);
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider["kimi-code"].models), ["live-model"]);
  assert.equal(cfg.provider["kimi-code"].models["live-model"].limit.context, 1048576);
});

test("entry module exports exactly the plugin (OpenCode invokes every export as a plugin)", () => {
  assert.deepEqual(Object.keys(mod).sort(), ["KimiCodePlugin", "default"]);
  assert.equal(typeof mod.KimiCodePlugin, "function");
  assert.equal(mod.default, mod.KimiCodePlugin);
});

test("config hook registers the provider + static models and logs it", async () => {
  rmSync(CACHE, { force: true });
  const { client, calls } = makeClient();
  const hooks = await KimiCodePlugin({ client });

  const cfg = {};
  await hooks.config(cfg);
  const provider = cfg.provider?.["kimi-code"];
  assert.ok(provider, "config hook must add the kimi-code provider");
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.ok(provider.options.baseURL.includes("api.kimi.com"), "baseURL points at kimi");
  assert.ok(Object.keys(provider.models).includes("k3"), "k3 model registered");
  assert.equal(provider.models.k3.temperature, false, "temperature disabled (kimi requires temp=1)");

  await settle();
  assert.ok(
    calls.logs.some((l) => l.service === "kimi-subscription" && /registered/.test(l.message)),
    "registration is logged via client.app.log",
  );
  assert.ok(
    calls.logs.every((l) => ["debug", "info", "warn", "error"].includes(l.level)),
    "log levels are valid",
  );
});

test("config hook respects an existing user-defined kimi-code provider", async () => {
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const custom = { provider: { "kimi-code": { npm: "x", options: { baseURL: "https://custom" }, models: {} } } };
  await hooks.config(custom);
  assert.equal(custom.provider["kimi-code"].options.baseURL, "https://custom", "must not overwrite user config");
});

test("config hook picks up models from the discovery cache", async () => {
  writeFileSync(
    CACHE,
    JSON.stringify({
      ts: Date.now(),
      models: [
        { id: "k3", display_name: "Kimi K3", context_length: 1_048_576 },
        { id: "k9-future", display_name: "Kimi K9 (future)", context_length: 2_000_000, supports_reasoning: true },
      ],
    }),
  );
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const cfg = {};
  await hooks.config(cfg);
  const models = cfg.provider["kimi-code"].models;
  assert.ok(Object.keys(models).includes("k9-future"), "config hook picks up newly-cached models");
  assert.equal(models["k9-future"].limit.context, 2_000_000, "cached context window applied");
});

test("auth hook registers the oauth method and loader shape", async () => {
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  assert.equal(hooks.auth.provider, "kimi-code");
  const method = hooks.auth.methods.find((m) => m.type === "oauth");
  assert.equal(method?.label, "Sign in with Kimi (subscription)");
  const opts = await hooks.auth.loader(async () => FRESH_AUTH());
  assert.equal(typeof opts.fetch, "function", "loader returns a fetch");
  assert.equal(opts.apiKey, "");
});

test("loader fetch injects the bearer token and strips x-api-key", async (t) => {
  seedFreshCache();
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => FRESH_AUTH());

  let seen;
  stubFetch(t, [[API_URL, (init) => ((seen = init), jsonResponse(200, { ok: true }))]]);
  const res = await pluginFetch(API_URL, { method: "POST", headers: { "x-api-key": "leak" } });

  assert.equal(res.status, 200);
  assert.equal(seen.headers.get("authorization"), "Bearer AAA");
  assert.equal(seen.headers.get("x-api-key"), null, "x-api-key must be stripped");
});

test("loader fetch pins temperature to 1 through the real request path", async (t) => {
  seedFreshCache();
  const { client } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => FRESH_AUTH());

  let seen;
  stubFetch(t, [[API_URL, (init) => ((seen = init), jsonResponse(200, { ok: true }))]]);
  await pluginFetch(API_URL, { method: "POST", body: JSON.stringify({ model: "k3", temperature: 0 }) });

  assert.deepEqual(JSON.parse(seen.body), { model: "k3", temperature: 1 });
});

test("upstream 401 forces one refresh and one retry, persisting the new token", async (t) => {
  seedFreshCache();
  const { client, calls } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => FRESH_AUTH());

  const apiInits = [];
  const refreshInits = [];
  stubFetch(t, [
    ["/api/oauth/token", (init) => (refreshInits.push(init), jsonResponse(200, REFRESH_OK))],
    [API_URL, (init) => (apiInits.push(init), jsonResponse(apiInits.length === 1 ? 401 : 200, { ok: true }))],
  ]);
  const res = await pluginFetch(API_URL, { method: "POST" });

  assert.equal(res.status, 200);
  assert.equal(apiInits.length, 2, "exactly one retry");
  assert.equal(refreshInits.length, 1, "exactly one refresh call");
  assert.equal(refreshInits[0].body.get("grant_type"), "refresh_token");
  assert.equal(apiInits[1].headers.get("authorization"), "Bearer NEW", "retry uses the refreshed token");
  assert.equal(calls.authSet[0]?.body.access, "NEW", "new token persisted via client.auth.set");
});

test("a near-expiry stored token is refreshed before the first upstream attempt", async (t) => {
  seedFreshCache();
  const { client, calls } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => STALE_AUTH());

  const apiInits = [];
  let refreshes = 0;
  stubFetch(t, [
    ["/api/oauth/token", () => (refreshes++, jsonResponse(200, REFRESH_OK))],
    [API_URL, (init) => (apiInits.push(init), jsonResponse(200, { ok: true }))],
  ]);
  await pluginFetch(API_URL, { method: "POST" });

  assert.equal(refreshes, 1, "refresh happens up front");
  assert.equal(apiInits.length, 1, "no retry needed");
  assert.equal(apiInits[0].headers.get("authorization"), "Bearer NEW");
  assert.equal(calls.authSet[0]?.body.access, "NEW");
});

test("a failed refresh propagates, never hits the API, and raises a toast", async (t) => {
  seedFreshCache();
  const { client, calls } = makeClient();
  const hooks = await KimiCodePlugin({ client });
  const { fetch: pluginFetch } = await hooks.auth.loader(async () => STALE_AUTH());

  const fetchCalls = stubFetch(t, [
    ["/api/oauth/token", () => jsonResponse(401, { error: "invalid_grant" })],
    [API_URL, () => jsonResponse(200, { ok: true })],
  ]);
  await assert.rejects(pluginFetch(API_URL, { method: "POST" }), /token refresh failed \(HTTP 401\)/);

  assert.ok(
    fetchCalls.every((c) => !c.url.includes(API_URL)),
    "API is never called with a dead token",
  );
  await settle();
  assert.ok(
    calls.toasts.some((tst) => tst.variant === "error" && /session expired/.test(tst.message)),
    "session-expired toast raised",
  );
});

for (const stale of [false, true]) {
  test(`startup discovers models before any completion (stale auth: ${stale})`, async (t) => {
    rmSync(CACHE, { force: true });
    writeFileSync(AUTH_FILE, JSON.stringify({ "kimi-code": stale ? STALE_AUTH() : FRESH_AUTH() }));
    t.after(() => rmSync(AUTH_FILE, { force: true }));
    const { client, calls } = makeClient();
    const requests = stubFetch(t, [
      ["/api/oauth/token", () => jsonResponse(200, REFRESH_OK)],
      [
        "/models",
        (init) => {
          assert.equal(init.headers.Authorization, `Bearer ${stale ? "NEW" : "AAA"}`);
          return jsonResponse(200, { data: [{ id: "new-model", display_name: "New", context_length: 1048576 }] });
        },
      ],
    ]);
    const hooks = await KimiCodePlugin({ client });
    const cfg = {};
    await hooks.config(cfg);
    assert.deepEqual(Object.keys(cfg.provider["kimi-code"].models), ["new-model"]);
    assert.equal(cfg.provider["kimi-code"].models["new-model"].limit.context, 1048576);
    assert.equal(calls.authSet.length, stale ? 1 : 0);
    assert.equal(JSON.parse(readFileSync(CACHE)).models[0].id, "new-model");
    await hooks.config({});
    assert.equal(requests.filter((r) => r.url.endsWith("/models")).length, 1, "fresh cache avoids repeat discovery");
  });
}

for (const response of [
  () => jsonResponse(503, {}),
  () => jsonResponse(200, { data: [{ id: 123 }] }),
  () => jsonResponse(200, { data: [] }),
]) {
  test("failed startup discovery preserves stale cache", async (t) => {
    writeFileSync(CACHE, JSON.stringify({ ts: 1, models: [{ id: "cached-model" }] }));
    writeFileSync(AUTH_FILE, JSON.stringify({ "kimi-code": FRESH_AUTH() }));
    t.after(() => rmSync(AUTH_FILE, { force: true }));
    stubFetch(t, [["/models", response]]);
    const { client } = makeClient();
    const hooks = await KimiCodePlugin({ client });
    const cfg = {};
    await hooks.config(cfg);
    assert.deepEqual(Object.keys(cfg.provider["kimi-code"].models), ["cached-model"]);
    assert.equal(JSON.parse(readFileSync(CACHE)).ts, 1);
  });
}
