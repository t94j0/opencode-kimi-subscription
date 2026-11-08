// Live integration test — drives the real OAuth device-authorization endpoint
// through the plugin's own authorize callback. Opt-in only: set KIMI_INTEGRATION=1.
//
//   KIMI_INTEGRATION=1 npm run build && node test/integration.mjs
//
// Prints the verification URL to open in the browser, then exits (the device
// flow keeps polling inside OpenCode after real sign-in).
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.KIMI_INTEGRATION !== "1") {
  console.log("integration test skipped (set KIMI_INTEGRATION=1 to run)");
  process.exit(0);
}

process.env.KIMI_SUBSCRIPTION_CACHE = join(tmpdir(), `kimi-integration-${process.pid}.json`);
const { default: plugin } = await import("../dist/index.js");

// Minimal no-op plugin context: we only exercise the oauth method registration.
const noopEditor = {
  list: () => [],
  get: () => undefined,
  update: () => {},
  remove: () => {},
  method: { list: () => [], update: (reg) => (captured.push(reg)), remove: () => {} },
};
const captured = [];
const ctx = {
  app: { name: "opencode", version: "test", channel: "test" },
  location: { directory: tmpdir(), project: { id: "p", directory: tmpdir(), canonical: tmpdir() } },
  options: {},
  provider: {
    list: async () => [],
    transform: async () => ({ dispose: async () => {} }),
    reload: async () => {},
  },
  integration: {
    transform: async (cb) => (cb(noopEditor), { dispose: async () => {} }),
    connection: { active: async () => undefined, resolve: async () => undefined, status: async () => {} },
  },
  session: { hook: async () => ({ dispose: async () => {} }) },
};

const cleanup = await plugin.setup(ctx);
const reg = captured.find((r) => r.method.type === "oauth");
assert.ok(reg, "oauth method registered");

const authz = await reg.authorize({});
console.log("Device flow started. Open:\n  " + authz.url);
console.log(authz.instructions);
// Do not wait for the browser approval here — the callback keeps polling.
if (typeof cleanup === "function") await cleanup();
process.exit(0);
