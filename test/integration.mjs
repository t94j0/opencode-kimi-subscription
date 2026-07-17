// Live integration test — drives the real plugin against the Kimi API.
// Opt-in only: set KIMI_INTEGRATION=1 and be logged in (via `opencode auth
// login` or the `kimi` CLI). Skips cleanly otherwise, so CI stays offline.
//
//   KIMI_INTEGRATION=1 npm run build && node test/integration.mjs
import assert from "node:assert";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.KIMI_INTEGRATION !== "1") {
  console.log("• integration test skipped (set KIMI_INTEGRATION=1 to run)");
  process.exit(0);
}

// Isolate the model cache before importing the plugin.
const CACHE = join(tmpdir(), `kimi-integration-${process.pid}.json`);
process.env.KIMI_SUBSCRIPTION_CACHE = CACHE;
const { KimiCodePlugin } = await import("../dist/index.js");

// Source a token from OpenCode's auth store, else the kimi CLI credentials.
const OPENCODE_AUTH = join(homedir(), ".local/share/opencode/auth.json");
const KIMI_CRED = join(homedir(), ".kimi-code/credentials/kimi-code.json");
let store = null;
let auth = null;
try {
  const a = JSON.parse(readFileSync(OPENCODE_AUTH, "utf8"))["kimi-code"];
  if (a?.type === "oauth") {
    auth = a;
    store = "opencode";
  }
} catch {}
if (!auth) {
  try {
    const c = JSON.parse(readFileSync(KIMI_CRED, "utf8"));
    if (c?.access_token) {
      auth = { type: "oauth", access: c.access_token, refresh: c.refresh_token, expires: c.expires_at * 1000 };
      store = "kimi";
    }
  } catch {}
}
assert.ok(auth, "no Kimi credentials found — run `opencode auth login` or `kimi` first");
console.log(`• using credentials from: ${store}`);

// Mock client; persists refreshed tokens back to whichever store we read.
const client = {
  app: { log: async () => true },
  tui: { showToast: async () => true },
  auth: {
    set: async ({ body }) => {
      auth = body;
      if (store === "opencode") {
        const all = JSON.parse(readFileSync(OPENCODE_AUTH, "utf8"));
        all["kimi-code"] = body;
        writeFileSync(OPENCODE_AUTH, JSON.stringify(all, null, 2), { mode: 0o600 });
      } else {
        writeFileSync(
          KIMI_CRED,
          JSON.stringify(
            {
              access_token: body.access,
              refresh_token: body.refresh,
              expires_at: Math.floor(body.expires / 1000),
              scope: "kimi-code",
              token_type: "Bearer",
              expires_in: Math.round((body.expires - Date.now()) / 1000),
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600 },
        );
      }
      return true;
    },
  },
};

const hooks = await KimiCodePlugin({ client });

// Live completion through the plugin loader (auth injected, temperature pinned).
// This also fires the fire-and-forget model-cache refresh.
const { fetch: pluginFetch } = await hooks.auth.loader(async () => auth);
const res = await pluginFetch("https://api.kimi.com/coding/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "k3",
    messages: [{ role: "user", content: "reply with exactly: INTEGRATION OK" }],
    temperature: 0, // deliberately wrong; the plugin must pin to 1
    max_tokens: 200,
  }),
});
assert.equal(res.status, 200, `expected 200, got ${res.status}`);
const json = await res.json();
const content = json.choices?.[0]?.message?.content ?? "";
assert.ok(/INTEGRATION OK/.test(content), `unexpected content: ${JSON.stringify(content)}`);
console.log("✓ live completion via plugin loader:", JSON.stringify(content));

// The request should have discovered + cached the live model list.
let cached = null;
for (let i = 0; i < 40 && !cached; i++) {
  if (existsSync(CACHE)) cached = JSON.parse(readFileSync(CACHE, "utf8"));
  else await new Promise((r) => setTimeout(r, 100));
}
assert.ok(cached?.models?.length, "live /models discovery wrote the model cache");
console.log("✓ live model discovery cached:", cached.models.map((m) => m.id).join(", "));
rmSync(CACHE, { force: true });

console.log("\nIntegration test passed.");
