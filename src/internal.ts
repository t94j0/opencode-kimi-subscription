import { Credential, Integration, Model, Provider } from "@opencode/plugin";

export const DEFAULT_OUTPUT_LIMIT = 65_536;
export const METHOD = Integration.MethodID.make("device");

export type Region = "mainland-cn" | "global";
const REGION_HOSTS = {
  "mainland-cn": { oauthHost: "https://auth.kimi.com", apiBase: "https://api.kimi.com/coding/v1" },
  global: { oauthHost: "https://auth.kimi.ai", apiBase: "https://api.kimi.ai/coding/v1" },
} as const;

export function resolveRegion(options: { region?: unknown }, env: NodeJS.ProcessEnv = process.env) {
  const selected = options.region;
  if (selected !== undefined && selected !== "mainland-cn" && selected !== "global") {
    throw new Error('Kimi region must be "mainland-cn" or "global"');
  }
  const oauthOverride = env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST;
  const apiOverride = env.KIMI_CODE_BASE_URL;
  const knownRegion = (value: string | undefined) => {
    if (!value) return undefined;
    let host: string;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid protocol");
      host = url.hostname;
    } catch {
      throw new Error("Invalid Kimi endpoint override");
    }
    if (host === "auth.kimi.ai" || host === "api.kimi.ai") return "global";
    if (host === "auth.kimi.com" || host === "api.kimi.com") return "mainland-cn";
    return undefined;
  };
  const oauthRegion = knownRegion(oauthOverride);
  const apiRegion = knownRegion(apiOverride);
  if (oauthRegion && apiRegion && oauthRegion !== apiRegion)
    throw new Error("Kimi OAuth and API endpoints use different regions");
  const inferred = oauthRegion || apiRegion;
  if (selected && inferred && selected !== inferred) throw new Error("Kimi region conflicts with endpoint override");
  const region: Region = selected || inferred || "mainland-cn";
  const hosts = REGION_HOSTS[region];
  const id = region === "global" ? "kimi-code-global" : "kimi-code";
  return {
    region,
    providerID: Provider.ID.make(id),
    integrationID: Integration.ID.make(id),
    label: `Kimi Code (${region === "global" ? "Global" : "China"} subscription)`,
    oauthHost: (oauthOverride || hosts.oauthHost).replace(/\/+$/, ""),
    apiBase: (apiOverride || hosts.apiBase).replace(/\/+$/, ""),
  };
}

export type UpstreamModel = {
  id?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supports_image_in?: unknown;
  supports_video_in?: unknown;
  supports_tool_use?: unknown;
};

export type DiscoveredModel = UpstreamModel & { id: string };
export type ModelCache = { ts: number; models: DiscoveredModel[]; region?: Region };
export type DeviceAuthorization = {
  device_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  expires_in: number;
  interval: number;
};

export class RefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isModel = (model: unknown): model is DiscoveredModel =>
  !!model &&
  typeof model === "object" &&
  typeof (model as UpstreamModel).id === "string" &&
  (model as DiscoveredModel).id.trim().length > 0;

export function isValidModelCache(cache: unknown, region: Region = "mainland-cn"): cache is ModelCache {
  if (!cache || typeof cache !== "object") return false;
  const value = cache as Partial<ModelCache>;
  return (
    (value.region === region || (region === "mainland-cn" && value.region === undefined)) &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    value.models.every(isModel)
  );
}

export function toCredential(data: Record<string, unknown>, now = Date.now()): Credential.OAuth {
  if (typeof data.access_token !== "string" || !data.access_token.trim()) throw new Error("missing access token");
  if (typeof data.refresh_token !== "string" || !data.refresh_token.trim()) throw new Error("missing refresh token");
  const seconds = data.expires_in === undefined ? 900 : Number(data.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid token expiry");
  return {
    type: "oauth",
    methodID: METHOD,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: now + seconds * 1000,
  };
}

export function toModelInfo(model: DiscoveredModel, providerID: Provider.ID): Model.Info {
  const id = Model.ID.make(model.id);
  const baseline = Model.Info.default(providerID, id);
  const context = Number(model.context_length);
  return {
    ...baseline,
    name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.id,
    limit: {
      context: Number.isSafeInteger(context) && context > 0 ? context : 262_144,
      output: DEFAULT_OUTPUT_LIMIT,
    },
    capabilities: {
      ...baseline.capabilities,
      tools: model.supports_tool_use !== false,
      input: [
        "text",
        ...(model.supports_image_in === true ? ["image"] : []),
        ...(model.supports_video_in === true ? ["video"] : []),
      ],
      temperature: false,
    },
  };
}

export type PollResult =
  | { kind: "success"; data: Record<string, unknown> }
  | { kind: "pending"; err: string }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; status: number };

export function classifyPollResponse(status: number, data: Record<string, unknown>): PollResult {
  if (status === 200 && typeof data.access_token === "string" && data.access_token) return { kind: "success", data };
  const err = data.error;
  if (err === "authorization_pending" || err === "slow_down") return { kind: "pending", err };
  if (err === "access_denied") return { kind: "denied" };
  if (err === "expired_token") return { kind: "expired" };
  return { kind: "error", status };
}
