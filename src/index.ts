// opencode-kimi-subscription (local fork, v0.2.0) — use your Kimi Code (Moonshot)
// subscription in OpenCode 2.x.
//
// Port of t94j0/opencode-kimi-subscription (MIT, v0.1.0) from the OpenCode V1
// plugin API (default-exported async function) to the V2 `Plugin.define` API,
// targeting OpenCode 2.2.x / @opencode/plugin 2.2.4.
//
// What it does:
//  - self-registers the `kimi-code` provider (OpenAI-compatible,
//    https://api.kimi.com/coding/v1) with the models discovered live from
//    /models (6h TTL, on-disk cache, static baseline fallback); a user-defined
//    `kimi-code` provider in config is respected as-is
//  - adds a "Sign in with Kimi (subscription)" OAuth device-flow method to the
//    `kimi-code` integration; the short-lived (15 min) access token is
//    refreshed automatically via the registered `refresh` callback
//  - pins temperature to 1 for every kimi-code request (kimi coding models
//    only accept temperature === 1)
//  - retries once on 401/403 (expired-token race)
//
// Load from opencode.json(c):
//   { "plugin": ["d:/AI_PetProjects/opencode-kimi-subscription"] }
//
// Then sign in once (TUI: /connect -> kimi-code -> "Sign in with Kimi
// (subscription)") and approve the device flow in your browser.
//
// Endpoints / client_id / params are from the original plugin (derived from
// the kimi CLI v0.26.0).

import { Credential, Integration, Model, Plugin, Provider } from "@opencode/plugin";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_OUTPUT_LIMIT,
  classifyPollResponse,
  errorMessage,
  isValidModelCache,
  RefreshError,
  type DeviceAuthorization,
  type DiscoveredModel,
  type ModelCache,
  type UpstreamModel,
} from "./internal.js";

const PROVIDER = "kimi-code" as Provider.ID;
const INTEGRATION = "kimi-code" as Integration.ID;
const METHOD = "device" as Integration.MethodID;
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
const PROVIDER_NAME = "Kimi Code (subscription)";

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "");
const OAUTH_HOST = stripTrailingSlashes(
  process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com",
);
const API_BASE = stripTrailingSlashes(process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1");
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const LOGIN_TIMEOUT_MS = 900_000;
// A hung fetch would otherwise wedge model sync forever or latch the
// single-flight guard.
const FETCH_TIMEOUT_MS = 30_000;

// Where discovered models are cached, and how long before we refresh them.
const CACHE_FILE =
  process.env.KIMI_SUBSCRIPTION_CACHE ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-kimi-subscription", "models.json");
const MODEL_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Static baseline (context windows from the CLI). Seeds the provider on first
// run / when logged out; live discovery replaces it once a sync has run.
const STATIC_MODELS: DiscoveredModel[] = [
  { id: "k3", display_name: "Kimi K3", context_length: 1_048_576, supports_reasoning: true, supports_tool_use: true },
  {
    id: "kimi-for-coding",
    display_name: "Kimi K2.7 Coding",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
  },
  {
    id: "kimi-for-coding-highspeed",
    display_name: "Kimi K2.7 Coding Highspeed",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm(path: string, params: Record<string, string>) {
  const res = await fetch(`${OAUTH_HOST}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data };
}

async function requestDeviceCode(): Promise<DeviceAuthorization> {
  const { status, data } = await postForm("/api/oauth/device_authorization", { client_id: CLIENT_ID });
  if (status !== 200 || !data.device_code) throw new Error(`device authorization failed (HTTP ${status})`);
  return data as DeviceAuthorization;
}

async function pollOnce(deviceCode: string) {
  const { status, data } = await postForm("/api/oauth/token", {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  });
  return classifyPollResponse(status, data);
}

async function refreshToken(refresh: string) {
  const { status, data } = await postForm("/api/oauth/token", {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  if (status !== 200 || !data.access_token || !data.refresh_token) {
    throw new RefreshError(`token refresh failed (HTTP ${status})`, status);
  }
  return data;
}

// Fetch the live model list for the subscription.
async function fetchModels(token: string): Promise<DiscoveredModel[]> {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`/models returned HTTP ${res.status}`);
  const json = (await res.json()) as { data?: UpstreamModel[] };
  return Array.isArray(json?.data) ? json.data.filter((m): m is DiscoveredModel => !!m && !!m.id) : [];
}

function readModelCache(): ModelCache | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (isValidModelCache(c)) return c;
  } catch {}
  return null;
}

function writeModelCache(models: DiscoveredModel[]) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), models }));
  } catch {}
}

// Kimi token response -> V2 credential record (expires in ms).
function toCredential(data: Record<string, any>, now = Date.now()): Credential.OAuth {
  return {
    type: "oauth",
    methodID: METHOD,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: now + Number(data.expires_in || 900) * 1000,
  };
}

// Upstream model -> V2 Model.Info (SDK defaults, per-model overrides).
function toModelInfo(m: DiscoveredModel): Model.Info {
  const base = Model.Info.default(PROVIDER, m.id as Model.ID);
  return {
    ...base,
    name: m.display_name || m.id,
    limit: { context: Number(m.context_length) || 262_144, output: DEFAULT_OUTPUT_LIMIT },
    capabilities: {
      ...base.capabilities,
      input: m.supports_image_in || m.supports_video_in ? ["text", "image"] : ["text"],
      // kimi coding models only accept temperature === 1; hide the knob.
      temperature: false,
    },
  };
}

const PROVIDER_INFO: Provider.Info = {
  id: PROVIDER,
  name: PROVIDER_NAME,
  activation: "enabled",
  package: PROVIDER_PACKAGE,
  settings: { baseURL: API_BASE },
  integrationID: INTEGRATION,
};

export default Plugin.define({
  id: "opencode-kimi-subscription",
  async setup(ctx) {
    // Structured-enough logging into the server log stream (best-effort;
    // logging must never throw into the request path).
    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
      console.log(`[kimi-subscription] ${level}: ${message}`, extra ? JSON.stringify(extra) : "");
    };

    // ---- models: freshest cache, else the static baseline -------------------
    const cached = readModelCache();
    let models = (cached?.models ?? STATIC_MODELS).map(toModelInfo);

    const listed = await ctx.provider.list();
    const existingIds: string[] = (Array.isArray(listed) ? listed : listed?.data ?? []).map((p) => p.id);
    const userDefined = existingIds.includes(PROVIDER);

    if (!userDefined) {
      // Registered transform: replayed on every catalog rebuild, so
      // `ctx.provider.reload()` after a model sync picks up the new list.
      await ctx.provider.transform((editor) => {
        if (!editor.get(PROVIDER)) editor.add({ info: PROVIDER_INFO, models });
      });
      log("debug", "registered kimi-code provider", { models: models.map((m) => m.id), source: cached ? "cache" : "static" });
    } else {
      log("debug", "skipping kimi-code registration (user-defined provider present)");
    }

    // Refresh the model list from /models (needs a signed-in credential),
    // throttled by TTL and a single-flight guard.
    let syncing = false;
    async function syncModels() {
      if (syncing) return;
      const current = readModelCache();
      if (current && Date.now() - current.ts < MODEL_TTL_MS) return;
      syncing = true;
      try {
        const connection = await ctx.integration.connection.active(INTEGRATION);
        if (!connection) return;
        const credential = await ctx.integration.connection.resolve(connection);
        if (!credential || credential.type !== "oauth") return;
        const discovered = await fetchModels(credential.access);
        if (discovered.length) {
          models = discovered.map(toModelInfo);
          writeModelCache(discovered);
          log("debug", "refreshed model list from /models", { models: discovered.map((m) => m.id) });
          if (!userDefined) await ctx.provider.reload();
        }
      } catch (err) {
        log("debug", "model sync failed; keeping current list", { error: errorMessage(err) });
      } finally {
        syncing = false;
      }
    }
    void syncModels();

    // ---- integration: OAuth device flow + token refresh ---------------------
    await ctx.integration.transform((editor) => {
      if (!editor.get(INTEGRATION)) {
        try {
          editor.update(INTEGRATION, (integration) => {
            integration.name = PROVIDER_NAME;
          });
        } catch {
          // Integration may materialize from the provider's integrationID.
        }
      }
      editor.method.update({
        integrationID: INTEGRATION,
        method: { id: METHOD, type: "oauth", label: "Sign in with Kimi (subscription)" },
        authorize: async () => {
          const dev = await requestDeviceCode();
          log("info", "device authorization started");
          const callback = (async () => {
            const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, Number(dev.expires_in || 600) * 1000);
            let interval = Math.max(1, Number(dev.interval || 5));
            while (Date.now() < deadline) {
              await sleep(interval * 1000);
              const r = await pollOnce(dev.device_code);
              if (r.kind === "success") {
                const a = toCredential(r.data);
                log("info", "signed in via device flow");
                // Pick up the live model list right after sign-in.
                void (async () => {
                  try {
                    const discovered = await fetchModels(a.access);
                    if (discovered.length) {
                      models = discovered.map(toModelInfo);
                      writeModelCache(discovered);
                      log("debug", "refreshed model list after sign-in", { models: discovered.map((m) => m.id) });
                      if (!userDefined) await ctx.provider.reload();
                    }
                  } catch (err) {
                    log("debug", "post-login model sync failed", { error: errorMessage(err) });
                  }
                })();
                return a;
              }
              if (r.kind === "denied" || r.kind === "expired" || r.kind === "error") {
                log("warn", "device flow did not complete", { reason: r.kind });
                throw new Error(
                  r.kind === "denied" ? "Kimi sign-in was denied" : r.kind === "expired" ? "Kimi device code expired" : `Kimi sign-in failed (HTTP ${r.status})`,
                );
              }
              if (r.err === "slow_down") interval += 5;
            }
            log("warn", "device flow timed out");
            throw new Error("Kimi sign-in timed out");
          })();
          return {
            url: dev.verification_uri_complete || dev.verification_uri || "",
            instructions: `Approve the sign-in in your browser.${dev.user_code ? ` Code: ${dev.user_code}` : ""}`,
            expiresAt: dev.expires_in ? Date.now() + dev.expires_in * 1000 : undefined,
            mode: "auto" as const,
            callback,
          };
        },
        refresh: async (credential) => {
          try {
            const next = toCredential(await refreshToken(credential.refresh));
            log("debug", "access token refreshed", { validForMs: next.expires - Date.now() });
            return next;
          } catch (err) {
            log("error", "token refresh failed", {
              status: err instanceof RefreshError ? err.status : undefined,
              error: errorMessage(err),
            });
            throw err;
          }
        },
      });
    });

    // kimi coding models only accept temperature === 1 — pin it on every
    // request (request-level guarantee, independent of UI).
    await ctx.session.hook(
      "context",
      (event) => {
        event.options.temperature = 1;
      },
      { providerID: PROVIDER },
    );

    // Expired-token race: give the core one more attempt after it has
    // refreshed the credential (refresh callback above).
    await ctx.session.hook(
      "retry",
      (event) => {
        if (event.attempt <= 1 && (event.error.status === 401 || event.error.status === 403)) {
          event.decision = { retry: true, delay: 0 };
        }
      },
      { providerID: PROVIDER },
    );

    log("info", `loaded (OpenCode ${ctx.app.version})`, { provider: PROVIDER, apiBase: API_BASE });

    const timer = setInterval(() => void syncModels(), MODEL_TTL_MS);
    return () => clearInterval(timer);
  },
});
