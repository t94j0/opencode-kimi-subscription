// Structural + behavioral smoke test for the V2 plugin — no network, no
// credentials required. Drives the `Plugin.define` setup() against a stub
// plugin context and verifies: provider self-registration (with the on-disk
// model cache), respect for a user-defined provider, the OAuth device-flow
// method (real authorize/refresh callbacks against a stubbed fetch), the
// /models sync, and the temperature/retry request hooks.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the model cache at a throwaway file BEFORE importing the plugin (the
// cache path is resolved at module load).
const CACHE = join(tmpdir(), `kimi-smoke-${process.pid}.json`);
process.env.KIMI_SUBSCRIPTION_CACHE = CACHE;
const mod = await import("../dist/index.js");
const plugin = mod.default;

after(() => rmSync(CACHE, { force: true }));

const OAUTH_HOST = "https://auth.kimi.com";
const DEV = {
  device_code: "DEV",
  verification_uri: "https://kimi.com/code",
  verification_uri_complete: "https://kimi.com/code?user_code=CODE12",
  user_code: "CODE12",
  expires_in: 600,
  interval: 1,
};
const TOKEN_OK = { access_token: "AAA", refresh_token: "RRR", expires_in: 900 };

// ---- stub plugin context --------------------------------------------------
function makeCtx({ providers = [], credential = null } = {}) {
  const calls = {
    providerTransforms: [],
    providerAdd: null,
    integrationTransforms: [],
    methodUpdates: [],
    hooks: [],
    reloads: 0,
  };
  const providerRecords = providers.map((p) => ({ provider: p, models: new Map() }));
  const providerEditor = {
    list: () => providerRecords,
    get: (id) => providerRecords.find((r) => r.provider.id === id),
    add: (input) => {
      providerRecords.push({ provider: input.info, models: new Map() });
      calls.providerAdd = input;
    },
    update: () => {},
    remove: () => {},
    models: { set: () => {}, update: () => {}, remove: () => {} },
  };
  const integrationRefs = [];
  const integrationEditor = {
    list: () => integrationRefs,
    get: (id) => integrationRefs.find((r) => r.id === id),
    update: (id, fn) => {
      const ref = integrationRefs.find((r) => r.id === id) || (integrationRefs.push({ id, name: "" }), integrationRefs[integrationRefs.length - 1]);
      fn(ref);
    },
    remove: () => {},
    method: { list: () => [], update: (reg) => calls.methodUpdates.push(reg), remove: () => {} },
  };
  const ctx = {
    app: { name: "opencode", version: "2.2.4-test", channel: "test" },
    location: { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } },
    options: {},
    provider: {
      list: async () => providerRecords.map((r) => r.provider),
      transform: async (cb) => {
        calls.providerTransforms.push(cb);
        cb(providerEditor);
        return { dispose: async () => {} };
      },
      reload: async () => calls.reloads++,
    },
    integration: {
      transform: async (cb) => {
        calls.integrationTransforms.push(cb);
        cb(integrationEditor);
        return { dispose: async () => {} };
      },
      connection: {
        active: async (id) => (credential ? { id: `c-${id}`, integrationID: id } : undefined),
        resolve: async () => credential,
      },
    },
    session: {
      hook: async (name, cb, opts) => {
        calls.hooks.push({ name, cb, opts });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, calls };
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(t, routes) {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    for (const [substring, handler] of routes) {
      if (url.includes(substring)) return handler(init);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

const FRESH_CREDENTIAL = () => ({ type: "oauth", methodID: "device", access: "AAA", refresh: "RRR", expires: Date.now() + 3_600_000 });
const seedCache = (models, ts = Date.now()) => writeFileSync(CACHE, JSON.stringify({ ts, models }));

async function runSetup(t, opts = {}) {
  const { ctx, calls } = makeCtx(opts);
  const cleanup = await plugin.setup(ctx);
  t.after(() => (typeof cleanup === "function" ? cleanup() : undefined));
  return { ctx, calls };
}

const methodReg = (calls) => {
  const reg = calls.methodUpdates.find((m) => m.method.type === "oauth");
  assert.ok(reg, "oauth method registered");
  return reg;
};

// ---- tests ----------------------------------------------------------------

test("entry module exports a V2 plugin definition (id + setup)", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(plugin.id, "opencode-kimi-subscription");
  assert.equal(typeof plugin.setup, "function");
});

test("setup registers the kimi-code provider with the on-disk cache models", async (t) => {
  seedCache([
    { id: "k3", display_name: "Kimi K3", context_length: 1_048_576 },
    { id: "k9-future", display_name: "Kimi K9 (future)", context_length: 2_000_000, supports_reasoning: true },
  ]);
  const { calls } = await runSetup(t);

  assert.equal(calls.providerTransforms.length, 1, "provider transform registered");
  const added = calls.providerAdd;
  assert.ok(added, "provider added via transform");
  assert.equal(added.info.id, "kimi-code");
  assert.equal(added.info.name, "Kimi Code (subscription)");
  assert.equal(added.info.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(added.info.activation, "enabled");
  assert.ok(added.info.settings.baseURL.includes("api.kimi.com"), "baseURL points at kimi");
  const ids = added.models.map((m) => m.id);
  assert.ok(ids.includes("k9-future"), "cached model registered");
  const k9 = added.models.find((m) => m.id === "k9-future");
  assert.equal(k9.name, "Kimi K9 (future)");
  assert.equal(k9.limit.context, 2_000_000, "cached context window applied");
  assert.equal(k9.providerID, "kimi-code");
});

test("setup falls back to the static baseline without a cache", async (t) => {
  rmSync(CACHE, { force: true });
  const { calls } = await runSetup(t);
  const ids = calls.providerAdd.models.map((m) => m.id);
  assert.deepEqual(ids.sort(), ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]);
});

test("setup respects a user-defined kimi-code provider", async (t) => {
  rmSync(CACHE, { force: true });
  const { calls } = await runSetup(t, { providers: [{ id: "kimi-code", name: "Custom", activation: "enabled", package: "x" }] });
  assert.equal(calls.providerTransforms.length, 0, "no provider transform for a user-defined provider");
  assert.ok(methodReg(calls), "oauth method is still registered");
});

test("setup registers the OAuth device-flow method on the kimi-code integration", async (t) => {
  rmSync(CACHE, { force: true });
  const { calls } = await runSetup(t);
  const reg = methodReg(calls);
  assert.equal(reg.integrationID, "kimi-code");
  assert.equal(reg.method.id, "device");
  assert.equal(reg.method.label, "Sign in with Kimi (subscription)");
  assert.equal(typeof reg.authorize, "function");
  assert.equal(typeof reg.refresh, "function");
});

test("authorize drives the device flow and resolves a credential (stubbed endpoints)", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await runSetup(t);
  const reg = methodReg(calls);

  let polls = 0;
  stubFetch(t, [
    [`${OAUTH_HOST}/api/oauth/device_authorization`, () => jsonResponse(200, DEV)],
    [
      `${OAUTH_HOST}/api/oauth/token`,
      (init) => {
        assert.equal(init.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
        return jsonResponse(200, ++polls < 2 ? { error: "authorization_pending" } : TOKEN_OK);
      },
    ],
    ["api.kimi.com/coding/v1/models", () => jsonResponse(200, { data: [{ id: "k3" }] })],
  ]);

  const authz = await reg.authorize({});
  assert.equal(authz.url, "https://kimi.com/code?user_code=CODE12");
  assert.match(authz.instructions, /CODE12/);
  assert.equal(authz.mode, "auto");
  assert.ok(authz.callback instanceof Promise);

  const credential = await authz.callback;
  assert.deepEqual(
    { type: credential.type, methodID: credential.methodID, access: credential.access, refresh: credential.refresh },
    { type: "oauth", methodID: "device", access: "AAA", refresh: "RRR" },
  );
  assert.ok(credential.expires > Date.now() + 800_000, "expires ~15 min in the future");
});

test("refresh callback exchanges the refresh token for a new credential", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await runSetup(t);
  const reg = methodReg(calls);

  let grant;
  stubFetch(t, [
    [
      `${OAUTH_HOST}/api/oauth/token`,
      (init) => {
        grant = init.body.get("grant_type");
        return jsonResponse(200, { access_token: "NEW", refresh_token: "NEWR", expires_in: 900 });
      },
    ],
  ]);

  const next = await reg.refresh({ type: "oauth", methodID: "device", access: "OLD", refresh: "RRR", expires: Date.now() });
  assert.equal(grant, "refresh_token");
  assert.equal(next.access, "NEW");
  assert.equal(next.refresh, "NEWR");
  assert.equal(next.type, "oauth");
});

test("context hook pins temperature to 1 for kimi-code", async (t) => {
  rmSync(CACHE, { force: true });
  const { calls } = await runSetup(t);
  const hook = calls.hooks.find((h) => h.name === "context");
  assert.ok(hook, "context hook registered");
  assert.equal(hook.opts?.providerID, "kimi-code", "scoped to kimi-code");
  const event = { options: { temperature: 0.2 } };
  hook.cb(event);
  assert.equal(event.options.temperature, 1);
});

test("retry hook allows one retry on 401/403 for kimi-code", async (t) => {
  rmSync(CACHE, { force: true });
  const { calls } = await runSetup(t);
  const hook = calls.hooks.find((h) => h.name === "retry");
  assert.ok(hook, "retry hook registered");
  assert.equal(hook.opts?.providerID, "kimi-code", "scoped to kimi-code");

  const first = { attempt: 1, error: { status: 401, message: "expired" }, decision: { retry: false } };
  hook.cb(first);
  assert.deepEqual(first.decision, { retry: true, delay: 0 }, "401 -> retry once");

  const second = { attempt: 2, error: { status: 401, message: "expired" }, decision: { retry: false } };
  hook.cb(second);
  assert.deepEqual(second.decision, { retry: false }, "no second retry");

  const other = { attempt: 1, error: { status: 500, message: "boom" }, decision: { retry: false } };
  hook.cb(other);
  assert.deepEqual(other.decision, { retry: false }, "other statuses untouched");
});

test("stale model cache is refreshed from /models and the provider reloaded", async (t) => {
  seedCache([{ id: "stale-model" }], Date.now() - 7 * 60 * 60 * 1000);
  // Install the stub BEFORE setup: the initial syncModels() fires during setup.
  stubFetch(t, [
    ["api.kimi.com/coding/v1/models", () => jsonResponse(200, { data: [{ id: "live-model", display_name: "Live Model", context_length: 1000 }] })],
  ]);
  const { calls } = await runSetup(t, { credential: FRESH_CREDENTIAL() });

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (exists(CACHE) && readFileSync(CACHE, "utf8").includes("live-model")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const cached = JSON.parse(readFileSync(CACHE, "utf8"));
  assert.ok(cached.models.some((m) => m.id === "live-model"), "cache refreshed from /models");
  assert.ok(calls.reloads >= 1, "provider catalog reloaded");
});

function exists(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
