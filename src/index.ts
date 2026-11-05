// opencode-kimi-subscription — use your Kimi Code (Moonshot) subscription in OpenCode.
//
// Adds a "Sign in with Kimi (subscription)" login to `opencode auth login` that
// runs Kimi's OAuth 2.0 Device Authorization Grant, stores the token in
// OpenCode's own auth store, refreshes the short-lived (15 min) access token
// automatically, and self-registers the `kimi-code` provider + models — so the
// only setup is one line in opencode.json:
//
//   { "plugin": ["opencode-kimi-subscription"] }
//
// It obtains its own device token and never touches ~/.kimi-code, so the
// official `kimi` CLI keeps working alongside it.
//
// Discover models during config loading using OpenCode's stored OAuth token.
// Cache the list for 6h and fall back to cached/static models when offline.
// Request-time discovery keeps the cache fresh for the next startup.
//
// The endpoints/client_id/params below were derived from the kimi CLI (v0.26.0).
//
// OpenCode invokes every function exported from this module as a plugin, so
// only the plugin itself is exported; testable helpers live in internal.ts.

import type { AuthHook, Config, Plugin } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  classifyPollResponse,
  errorMessage,
  isValidModelCache,
  pinTemperature,
  toAuth,
  toConfigModel,
  RefreshError,
  type DeviceAuthorization,
  type DiscoveredModel,
  type ModelCache,
  type OAuthRecord,
} from "./internal.js";

type GetAuth = Parameters<NonNullable<AuthHook["loader"]>>[0];

const SERVICE = "kimi-subscription";
const PROVIDER = "kimi-code";
const PROVIDER_NPM = "@ai-sdk/openai-compatible";
const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "");
const OAUTH_HOST = stripTrailingSlashes(
  process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com",
);
const API_BASE = stripTrailingSlashes(process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1");
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Refresh when < 450s remain, matching the CLI's max(300, expires_in*0.5).
const REFRESH_SKEW_MS = 450_000;
const LOGIN_TIMEOUT_MS = 900_000;
// A hung fetch would otherwise wedge the refresh chain (and every request
// behind it) forever, or latch the model-sync guard.
const FETCH_TIMEOUT_MS = 30_000;

// Where discovered models are cached, and how long before we refresh them.
const CACHE_FILE =
  process.env.KIMI_SUBSCRIPTION_CACHE ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-kimi-subscription", "models.json");
// OpenCode exposes auth.set but no auth.get to plugins before the loader runs.
const AUTH_FILE = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");

async function readStoredAuth(): Promise<OAuthRecord> {
  const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"))[PROVIDER];
  if (auth?.type !== "oauth" || typeof auth.access !== "string" || typeof auth.refresh !== "string") {
    throw new Error("no stored Kimi OAuth credential");
  }
  return auth;
}

const MODEL_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Static baseline (context windows from the CLI). Seeds the provider on first
// run / when logged out; successful discovery replaces it at startup.
const STATIC_MODELS: DiscoveredModel[] = [
  {
    id: "k3",
    display_name: "Kimi K3",
    context_length: 1_048_576,
    supports_reasoning: true,
    supports_tool_use: true,
    supports_image_in: true,
    supports_video_in: true,
  },
  {
    id: "kimi-for-coding",
    display_name: "Kimi K2.7 Coding",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
    supports_image_in: true,
    supports_video_in: true,
  },
  {
    id: "kimi-for-coding-highspeed",
    display_name: "Kimi K2.7 Coding Highspeed",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
    supports_image_in: true,
    supports_video_in: true,
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
  const json = (await res.json()) as { data?: unknown } | null;
  const cache = { models: json?.data };
  if (!isValidModelCache(cache)) throw new Error("/models returned an invalid model list");
  return cache.models;
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

// The model list to register now: freshest cache, else the static baseline.
function resolveModels(): { models: DiscoveredModel[]; source: "cache" | "static" } {
  const cached = readModelCache();
  return cached ? { models: cached.models, source: "cache" } : { models: STATIC_MODELS, source: "static" };
}

const KimiCodePlugin: Plugin = async ({ client }) => {
  // Structured logging into OpenCode's own log stream (see it with
  // `opencode --print-logs` or in ~/.local/share/opencode/log/). Best-effort:
  // logging/toasts must never throw into the request path.
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    void Promise.resolve()
      .then(() => client.app?.log({ body: { service: SERVICE, level, message, ...(extra ? { extra } : {}) } }))
      .catch(() => {});
  };
  const toast = (variant: "info" | "success" | "warning" | "error", message: string, title?: string) => {
    void Promise.resolve()
      .then(() => client.tui?.showToast({ body: { variant, message, ...(title ? { title } : {}) } }))
      .catch(() => {});
  };

  // Refresh the on-disk model cache (used by the next startup). Fire-and-forget
  // from the request path, throttled by TTL and a single-flight guard.
  let syncingModels = false;
  async function maybeSyncModels(token: string) {
    const cached = readModelCache();
    if (cached && Date.now() - cached.ts < MODEL_TTL_MS) return cached.models;
    if (syncingModels) return;
    syncingModels = true;
    try {
      const models = await fetchModels(token);
      if (models.length) {
        writeModelCache(models);
        log("debug", "discovered models from /models", { models: models.map((m) => m.id) });
      }
      return models;
    } catch (err) {
      log("debug", "model cache refresh failed; keeping current list", { error: errorMessage(err) });
    } finally {
      syncingModels = false;
    }
  }

  // Coalesce concurrent refreshes; each re-reads the latest stored auth so a
  // rotated refresh_token is never reused.
  let chain: Promise<string> = Promise.resolve("");
  async function ensureFresh(getAuth: GetAuth, force: boolean): Promise<string> {
    chain = chain
      .catch(() => "")
      .then(async () => {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") {
          log("error", "no stored credential; login required");
          throw new Error(`${PROVIDER}: not logged in (run \`opencode auth login\`)`);
        }
        const stale = force || !auth.expires || auth.expires - Date.now() < REFRESH_SKEW_MS;
        if (!stale) return auth.access;
        if (!auth.refresh) {
          log("error", "stored credential has no refresh token; login required");
          toast("error", "Kimi sign-in is invalid — run: opencode auth login", "Kimi Code");
          throw new Error(`${PROVIDER}: no refresh token; re-login`);
        }
        try {
          const next = toAuth(await refreshToken(auth.refresh));
          await client.auth.set({ path: { id: PROVIDER }, body: next, throwOnError: true });
          log("debug", "access token refreshed", { validForMs: next.expires - Date.now() });
          return next.access;
        } catch (err) {
          const status = err instanceof RefreshError ? err.status : undefined;
          log("error", "token refresh failed", { status, error: errorMessage(err) });
          if (status === 401 || status === 403) {
            toast("error", "Kimi session expired — run: opencode auth login", "Kimi Code");
          }
          throw err;
        }
      });
    return chain;
  }

  return {
    // Discover before OpenCode resolves the model picker; preserve user config.
    config: async (config: Config) => {
      config.provider ??= {};
      if (!config.provider[PROVIDER]) {
        const cached = readModelCache();
        let discovered: DiscoveredModel[] | undefined;
        if (!cached || !(Date.now() - cached.ts < MODEL_TTL_MS)) {
          try {
            await readStoredAuth();
            discovered = await maybeSyncModels(await ensureFresh(readStoredAuth, false));
          } catch (err) {
            log("debug", "startup discovery unavailable; using cached/static models", { error: errorMessage(err) });
          }
        }
        const { models, source } = discovered ? { models: discovered, source: "discovery" } : resolveModels();
        config.provider[PROVIDER] = {
          npm: PROVIDER_NPM,
          name: "Kimi Code (subscription)",
          options: { baseURL: API_BASE },
          models: Object.fromEntries(models.map((m) => [m.id, toConfigModel(m)])),
        };
        log("debug", "registered kimi-code provider", { models: models.map((m) => m.id), source });
      }
    },

    auth: {
      provider: PROVIDER,
      loader: async (getAuth) => ({
        apiKey: "",
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const attempt = async (token: string) => {
            const headers = new Headers(init?.headers);
            headers.set("authorization", `Bearer ${token}`);
            headers.delete("x-api-key");
            const body = pinTemperature(init?.body);
            if (body !== init?.body) headers.delete("content-length");
            return fetch(input, { ...init, headers, body });
          };
          const token = await ensureFresh(getAuth, false);
          void maybeSyncModels(token); // fire-and-forget model-cache refresh
          let res = await attempt(token);
          if (res.status === 401 || res.status === 403) {
            log("warn", `upstream ${res.status}; forcing refresh and retrying once`);
            res = await attempt(await ensureFresh(getAuth, true));
          }
          return res;
        },
      }),
      methods: [
        {
          type: "oauth",
          label: "Sign in with Kimi (subscription)",
          authorize: async () => {
            const dev = await requestDeviceCode();
            log("info", "device authorization started");
            return {
              url: dev.verification_uri_complete || dev.verification_uri || "",
              instructions: `Approve the sign-in in your browser.${dev.user_code ? ` Code: ${dev.user_code}` : ""}`,
              method: "auto" as const,
              callback: async () => {
                const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, Number(dev.expires_in || 600) * 1000);
                let interval = Math.max(1, Number(dev.interval || 5));
                while (Date.now() < deadline) {
                  await sleep(interval * 1000);
                  const r = await pollOnce(dev.device_code);
                  if (r.kind === "success") {
                    const a = toAuth(r.data);
                    log("info", "signed in via device flow");
                    toast("success", "Signed in to Kimi (subscription)", "Kimi Code");
                    return { type: "success" as const, access: a.access, refresh: a.refresh, expires: a.expires };
                  }
                  if (r.kind === "denied" || r.kind === "expired" || r.kind === "error") {
                    log("warn", "device flow did not complete", { reason: r.kind });
                    return { type: "failed" as const };
                  }
                  if (r.err === "slow_down") interval += 5;
                }
                log("warn", "device flow timed out");
                return { type: "failed" as const };
              },
            };
          },
        },
      ],
    },
  };
};

export { KimiCodePlugin };
export default KimiCodePlugin;
