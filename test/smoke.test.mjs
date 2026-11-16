import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = join(tmpdir(), `kimi-smoke-${process.pid}.json`);
process.env.KIMI_SUBSCRIPTION_CACHE = CACHE;
const { default: plugin } = await import("../dist/index.js");
after(() => rmSync(CACHE, { force: true }));

const seedCache = (models, ts = Date.now(), region) => writeFileSync(CACHE, JSON.stringify({ ts, models, region }));
const response = (status, data) => new Response(JSON.stringify(data), { status });
const waitFor = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for asynchronous work");
};

function mockContext({ customProvider, credential, pluginOptions } = {}) {
  const calls = { providerTransforms: [], reloads: 0, hooks: [], methods: new Map(), lookups: [] };
  let providers = new Map();
  const rebuild = () => {
    providers = new Map(customProvider ? [["kimi-code", { info: customProvider, models: [] }]] : []);
    const editor = {
      get: (id) => providers.get(id),
      add: ({ info, models }) => providers.set(info.id, { info, models }),
    };
    for (const transform of calls.providerTransforms) transform(editor);
  };
  rebuild();
  const integrations = new Map();
  const ctx = {
    options: pluginOptions || {},
    provider: {
      transform: async (callback) => {
        calls.providerTransforms.push(callback);
        rebuild();
      },
      reload: async () => {
        calls.reloads++;
        rebuild();
      },
    },
    integration: {
      transform: async (callback) =>
        callback({
          get: (id) => integrations.get(id),
          update: (id, update) => {
            const item = integrations.get(id) || { id, name: "" };
            update(item);
            integrations.set(id, item);
          },
          method: { update: (registration) => calls.methods.set(registration.method.id, registration) },
        }),
      connection: {
        active: async (integrationID) => {
          calls.lookups.push(integrationID);
          return credential && integrationID === (credential.integrationID || "kimi-code")
            ? { id: "connection", integrationID }
            : undefined;
        },
        resolve: async () => credential,
      },
    },
    session: {
      hook: async (name, callback, options) => calls.hooks.push({ name, callback, options }),
    },
  };
  return { ctx, calls, providers, getProvider: (id = "kimi-code") => providers.get(id), integrations };
}

async function setup(t, options) {
  const result = mockContext(options);
  const cleanup = await plugin.setup(result.ctx);
  t.after(cleanup);
  return { ...result, cleanup };
}

test("entrypoint registers a V2 definition, provider, integration, and four request hooks", async (t) => {
  rmSync(CACHE, { force: true });
  assert.deepEqual(Object.keys(plugin).sort(), ["id", "setup"]);
  const { calls, getProvider, integrations } = await setup(t);
  assert.equal(plugin.id, "opencode-kimi-subscription");
  const provider = getProvider();
  assert.equal(provider.info.id, "kimi-code");
  assert.equal(provider.info.integrationID, "kimi-code");
  assert.equal(provider.info.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(provider.info.settings.baseURL, "https://api.kimi.com/coding/v1");
  assert.deepEqual(
    provider.models.map((m) => m.id),
    ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
  );
  assert.equal(integrations.get("kimi-code").name, "Kimi Code (China subscription)");
  assert.equal(calls.methods.get("device").method.type, "oauth");
  assert.deepEqual(
    calls.hooks.map((hook) => hook.name),
    ["context", "compaction", "generate", "title"],
  );
  for (const hook of calls.hooks) {
    assert.equal(hook.options.providerID, "kimi-code");
    const event = { options: { temperature: 0 } };
    hook.callback(event);
    assert.equal(event.options.temperature, 1);
  }
});

test("global setup isolates provider, integration, hooks, and model cache", async (t) => {
  seedCache([{ id: "global-cached" }], Date.now(), "global");
  const { calls, getProvider, integrations } = await setup(t, { pluginOptions: { region: "global" } });
  const provider = getProvider("kimi-code-global");
  assert.equal(provider.info.integrationID, "kimi-code-global");
  assert.equal(provider.info.settings.baseURL, "https://api.kimi.ai/coding/v1");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["global-cached"],
  );
  assert.equal(provider.models[0].providerID, "kimi-code-global");
  assert.equal(integrations.get("kimi-code-global").name, "Kimi Code (Global subscription)");
  assert.equal(calls.methods.get("device").integrationID, "kimi-code-global");
  assert.ok(calls.hooks.every((hook) => hook.options.providerID === "kimi-code-global"));

  seedCache([{ id: "china-only" }]);
  const other = await setup(t, { pluginOptions: { region: "global" }, credential: { integrationID: "kimi-code" } });
  assert.ok(other.getProvider("kimi-code-global").models.some((model) => model.id === "k3"));
  assert.equal(
    other.getProvider("kimi-code-global").models.some((model) => model.id === "china-only"),
    false,
  );
  await waitFor(() => other.calls.lookups.length > 0);
  assert.deepEqual(other.calls.lookups, ["kimi-code-global"]);
});

test("global device, refresh, and discovery use .ai endpoints", async (t) => {
  seedCache([{ id: "k3" }], Date.now(), "global");
  const { calls } = await setup(t, { pluginOptions: { region: "global" } });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    urls.push(String(input));
    if (String(input).endsWith("/api/oauth/device_authorization")) {
      return response(200, {
        device_code: "D",
        verification_uri: "https://kimi.ai/authorize",
        expires_in: 60,
        interval: 0.001,
      });
    }
    if (String(input).endsWith("/api/oauth/token")) {
      return response(200, { access_token: "A", refresh_token: "R", expires_in: 900 });
    }
    if (String(input).endsWith("/models")) return response(200, { data: [{ id: "live-global" }] });
    throw new Error(`unexpected URL ${input}`);
  });
  const method = calls.methods.get("device");
  const auth = await method.authorize({});
  await auth.callback;
  await method.refresh({ refresh: "R" });
  await waitFor(() => calls.reloads === 1);
  assert.ok(urls.includes("https://auth.kimi.ai/api/oauth/device_authorization"));
  assert.equal(urls.filter((url) => url === "https://auth.kimi.ai/api/oauth/token").length, 2);
  assert.ok(urls.includes("https://api.kimi.ai/coding/v1/models"));
  assert.equal(JSON.parse(readFileSync(CACHE, "utf8")).region, "global");
});

test("provider transform replays current models and preserves a custom provider", async (t) => {
  seedCache([{ id: "cached", context_length: 1234 }]);
  const { calls, getProvider, ctx } = await setup(t);
  assert.deepEqual(
    getProvider().models.map((m) => m.id),
    ["cached"],
  );
  seedCache([{ id: "new" }]);
  await ctx.provider.reload();
  assert.deepEqual(
    getProvider().models.map((m) => m.id),
    ["cached"],
    "reload uses captured inventory",
  );
  assert.equal(calls.providerTransforms.length, 1);
  const custom = { id: "kimi-code", name: "Mine" };
  const other = await setup(t, { customProvider: custom });
  assert.equal(other.getProvider().info, custom);
  assert.equal(other.calls.methods.get("device").method.type, "oauth");
});

test("device flow polls to success and refresh rotates credentials", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await setup(t);
  const method = calls.methods.get("device");
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/api/oauth/device_authorization")) {
      return response(200, {
        device_code: "D",
        verification_uri: "https://example.invalid/verify",
        expires_in: 60,
        interval: 0.001,
      });
    }
    if (String(input).endsWith("/api/oauth/token")) {
      if (init.body.get("grant_type") === "refresh_token") {
        assert.equal(init.body.get("refresh_token"), "R");
        return response(200, { access_token: "A2", refresh_token: "R2", expires_in: 900 });
      }
      return ++polls === 1
        ? response(400, { error: "authorization_pending" })
        : response(200, { access_token: "A", refresh_token: "R", expires_in: 900 });
    }
    if (String(input).endsWith("/models")) return response(200, { data: [{ id: "k3" }] });
    throw new Error(`unexpected URL ${input}`);
  });
  const authorization = await method.authorize({});
  assert.equal(authorization.url, "https://example.invalid/verify");
  assert.equal(authorization.mode, "auto");
  const credential = await authorization.callback;
  assert.deepEqual([credential.access, credential.refresh, credential.methodID], ["A", "R", "device"]);
  const rotated = await method.refresh(credential);
  assert.deepEqual([rotated.access, rotated.refresh], ["A2", "R2"]);
});

test("malformed device response fails before polling", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await setup(t);
  t.mock.method(globalThis, "fetch", async () =>
    response(200, { device_code: "D", verification_uri: "file:///tmp/oops" }),
  );
  await assert.rejects(calls.methods.get("device").authorize({}), /verification URL/);
});

test("bad refresh token response fails without returning an unusable credential", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await setup(t);
  t.mock.method(globalThis, "fetch", async () => response(200, { access_token: "A" }));
  await assert.rejects(calls.methods.get("device").refresh({ refresh: "R" }), /missing refresh token/);
});

test("stale cache refreshes on startup, then replays the new inventory", async (t) => {
  seedCache([{ id: "old" }], Date.now() - 7 * 60 * 60 * 1000);
  const credential = { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 900_000 };
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    assert.equal(init.headers.Authorization, "Bearer A");
    return response(200, { data: [{ id: "new", context_length: 1000 }] });
  });
  const { calls, getProvider } = await setup(t, { credential });
  await waitFor(() => calls.reloads > 0);
  assert.deepEqual(
    getProvider().models.map((m) => m.id),
    ["new"],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(CACHE, "utf8")).models.map((m) => m.id),
    ["new"],
  );
});

test("empty discovery leaves existing cache and provider intact", async (t) => {
  seedCache([{ id: "old" }], Date.now() - 7 * 60 * 60 * 1000);
  const before = readFileSync(CACHE, "utf8");
  t.mock.method(globalThis, "fetch", async () => response(200, { data: [{ id: "" }] }));
  const { calls, getProvider } = await setup(t, {
    credential: { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 900_000 },
  });
  await waitFor(() => calls.methods.has("device"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.reloads, 0);
  assert.equal(readFileSync(CACHE, "utf8"), before);
  assert.deepEqual(
    getProvider().models.map((m) => m.id),
    ["old"],
  );
});

test("concurrent sign-ins serialize forced model refreshes", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls } = await setup(t);
  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/api/oauth/device_authorization")) {
      return response(200, {
        device_code: "D",
        verification_uri: "https://example.invalid/verify",
        expires_in: 60,
        interval: 0.001,
      });
    }
    if (String(input).endsWith("/api/oauth/token")) {
      return response(200, { access_token: "A", refresh_token: "R", expires_in: 900 });
    }
    if (String(input).endsWith("/models")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return response(200, { data: [{ id: "k3" }] });
    }
    throw new Error(`unexpected URL ${input}`);
  });
  const method = calls.methods.get("device");
  const authorizations = await Promise.all([method.authorize({}), method.authorize({}), method.authorize({})]);
  await Promise.all(authorizations.map((authorization) => authorization.callback));
  await waitFor(() => calls.reloads === 3);
  assert.equal(maxInFlight, 1);
});

test("unload aborts pending device polling", async (t) => {
  seedCache([{ id: "k3" }]);
  const { calls, cleanup } = await setup(t);
  t.mock.method(globalThis, "fetch", async () =>
    response(200, { device_code: "D", verification_uri: "https://example.invalid", expires_in: 60, interval: 5 }),
  );
  const authorization = await calls.methods.get("device").authorize({});
  cleanup();
  await assert.rejects(authorization.callback, /abort/i);
});

test("unload prevents a late model response from replacing the cache", async (t) => {
  seedCache([{ id: "old" }], Date.now() - 7 * 60 * 60 * 1000);
  const before = readFileSync(CACHE, "utf8");
  let finish;
  let started = false;
  t.mock.method(globalThis, "fetch", () => {
    started = true;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const { calls, cleanup } = await setup(t, {
    credential: { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 900_000 },
  });
  await waitFor(() => started);
  cleanup();
  finish(response(200, { data: [{ id: "too-late" }] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.reloads, 0);
  assert.equal(readFileSync(CACHE, "utf8"), before);
});
