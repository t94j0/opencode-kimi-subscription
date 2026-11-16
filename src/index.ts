import { Plugin, Provider } from "@opencode/plugin";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  METHOD,
  RefreshError,
  classifyPollResponse,
  errorMessage,
  isModel,
  isValidModelCache,
  resolveRegion,
  toCredential,
  toModelInfo,
  type DeviceAuthorization,
  type DiscoveredModel,
  type ModelCache,
  type Region,
  type UpstreamModel,
} from "./internal.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const FETCH_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 900_000;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const STATIC_MODELS: DiscoveredModel[] = [
  { id: "k3", display_name: "Kimi K3", context_length: 1_048_576, supports_tool_use: true },
  { id: "kimi-for-coding", display_name: "Kimi K2.7 Coding", context_length: 262_144, supports_tool_use: true },
  {
    id: "kimi-for-coding-highspeed",
    display_name: "Kimi K2.7 Coding Highspeed",
    context_length: 262_144,
    supports_tool_use: true,
  },
];

function readModelCache(cacheFile: string, region: Region): ModelCache | null {
  try {
    const cache: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    return isValidModelCache(cache, region) ? cache : null;
  } catch {
    return null;
  }
}

function writeModelCache(cacheFile: string, region: Region, models: DiscoveredModel[]) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), region, models }));
  } catch (error) {
    console.warn("[kimi-subscription] could not write model cache:", errorMessage(error));
  }
}

function requestSignal(lifecycle: AbortSignal) {
  return AbortSignal.any([lifecycle, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

async function postForm(oauthHost: string, path: string, params: Record<string, string>, lifecycle: AbortSignal) {
  const response = await fetch(`${oauthHost}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: requestSignal(lifecycle),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { status: response.status, data };
}

async function requestDeviceCode(oauthHost: string, lifecycle: AbortSignal): Promise<DeviceAuthorization> {
  const { status, data } = await postForm(
    oauthHost,
    "/api/oauth/device_authorization",
    { client_id: CLIENT_ID },
    lifecycle,
  );
  if (status !== 200 || typeof data.device_code !== "string" || !data.device_code.trim()) {
    throw new Error(`device authorization failed (HTTP ${status})`);
  }
  const rawUrl = data.verification_uri_complete || data.verification_uri;
  if (typeof rawUrl !== "string" || !URL.canParse(rawUrl) || new URL(rawUrl).protocol !== "https:") {
    throw new Error("device authorization returned an invalid verification URL");
  }
  const expires = data.expires_in === undefined ? 600 : Number(data.expires_in);
  const interval = data.interval === undefined ? 5 : Number(data.interval);
  if (!Number.isFinite(expires) || expires <= 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new Error("device authorization returned invalid timing");
  }
  return {
    device_code: data.device_code,
    verification_uri: typeof data.verification_uri === "string" ? data.verification_uri : undefined,
    verification_uri_complete:
      typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : undefined,
    user_code: typeof data.user_code === "string" ? data.user_code : undefined,
    expires_in: expires,
    interval,
  };
}

async function pollOnce(oauthHost: string, deviceCode: string, lifecycle: AbortSignal) {
  const { status, data } = await postForm(
    oauthHost,
    "/api/oauth/token",
    { client_id: CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT },
    lifecycle,
  );
  return classifyPollResponse(status, data);
}

async function refreshToken(oauthHost: string, refresh: string, lifecycle: AbortSignal) {
  const { status, data } = await postForm(
    oauthHost,
    "/api/oauth/token",
    { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh },
    lifecycle,
  );
  if (status !== 200) throw new RefreshError(`token refresh failed (HTTP ${status})`, status);
  return toCredential(data);
}

async function fetchModels(apiBase: string, token: string, lifecycle: AbortSignal): Promise<DiscoveredModel[]> {
  const response = await fetch(`${apiBase}/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: requestSignal(lifecycle),
  });
  if (!response.ok) throw new Error(`/models returned HTTP ${response.status}`);
  const json = (await response.json()) as { data?: UpstreamModel[] };
  return Array.isArray(json?.data) ? json.data.filter(isModel) : [];
}

export default Plugin.define({
  id: "opencode-kimi-subscription",
  async setup(ctx) {
    const { region, providerID, integrationID, label, oauthHost, apiBase } = resolveRegion(ctx.options);
    const cacheFile =
      process.env.KIMI_SUBSCRIPTION_CACHE ||
      join(
        process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "opencode-kimi-subscription",
        region === "global" ? "models-global.json" : "models.json",
      );
    const lifecycle = new AbortController();
    let models = (readModelCache(cacheFile, region)?.models ?? STATIC_MODELS).map((model) =>
      toModelInfo(model, providerID),
    );
    let syncing: Promise<void> | undefined;

    async function syncModels(token?: string, force = false) {
      while (syncing) {
        await syncing;
        if (!force) return;
      }
      if (!force) {
        const cached = readModelCache(cacheFile, region);
        if (cached && Number.isFinite(cached.ts) && Date.now() - cached.ts < MODEL_TTL_MS) return;
      }
      syncing = (async () => {
        try {
          if (!token) {
            const connection = await ctx.integration.connection.active(integrationID);
            if (!connection || lifecycle.signal.aborted) return;
            const credential = await ctx.integration.connection.resolve(connection);
            if (credential?.type !== "oauth" || lifecycle.signal.aborted) return;
            token = credential.access;
          }
          const discovered = await fetchModels(apiBase, token, lifecycle.signal);
          if (!discovered.length || lifecycle.signal.aborted) return;
          models = discovered.map((model) => toModelInfo(model, providerID));
          writeModelCache(cacheFile, region, discovered);
          if (!lifecycle.signal.aborted) await ctx.provider.reload();
        } catch (error) {
          if (!lifecycle.signal.aborted) console.warn("[kimi-subscription] model sync failed:", errorMessage(error));
        }
      })().finally(() => {
        syncing = undefined;
      });
      await syncing;
    }

    await ctx.provider.transform((editor) => {
      if (editor.get(providerID)) return;
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          integrationID,
          name: label,
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: apiBase },
        },
        models,
      });
    });

    await ctx.integration.transform((editor) => {
      if (!editor.get(integrationID)) editor.update(integrationID, (item) => (item.name = label));
      editor.method.update({
        integrationID,
        method: { id: METHOD, type: "oauth", label: `Sign in with ${label}` },
        authorize: async () => {
          const device = await requestDeviceCode(oauthHost, lifecycle.signal);
          const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, device.expires_in * 1000);
          const callback = (async () => {
            let interval = device.interval;
            while (Date.now() < deadline) {
              await sleep(Math.min(interval * 1000, deadline - Date.now()), undefined, { signal: lifecycle.signal });
              if (Date.now() >= deadline) break;
              const result = await pollOnce(oauthHost, device.device_code, lifecycle.signal);
              if (result.kind === "success") {
                const credential = toCredential(result.data);
                void syncModels(credential.access, true);
                return credential;
              }
              if (result.kind === "denied") throw new Error("Kimi sign-in was denied");
              if (result.kind === "expired") throw new Error("Kimi device code expired");
              if (result.kind === "error") throw new Error(`Kimi sign-in failed (HTTP ${result.status})`);
              if (result.err === "slow_down") interval += 5;
            }
            throw new Error("Kimi sign-in timed out");
          })();
          return {
            url: device.verification_uri_complete || device.verification_uri!,
            instructions: `Approve the sign-in in your browser.${device.user_code ? ` Code: ${device.user_code}` : ""}`,
            expiresAt: deadline,
            mode: "auto" as const,
            callback,
          };
        },
        refresh: async (credential) => refreshToken(oauthHost, credential.refresh, lifecycle.signal),
      });
    });

    for (const name of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(
        name,
        (event) => {
          event.options.temperature = 1;
        },
        { providerID },
      );
    }

    void syncModels();
    const timer = setInterval(() => void syncModels(), MODEL_TTL_MS);
    return () => {
      lifecycle.abort();
      clearInterval(timer);
    };
  },
});
