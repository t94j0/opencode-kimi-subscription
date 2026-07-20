// Pure helpers for the plugin, kept out of the entry module so they can be
// unit-tested: OpenCode invokes every function exported from a plugin's entry
// module as a plugin, so index.ts imports from here and re-exports nothing.

export const DEFAULT_OUTPUT_LIMIT = 65_536;

// Upstream /models item shape (subset we use). All fields optional/loose since
// it's a network payload.
export type UpstreamModel = {
  id?: string;
  display_name?: string;
  context_length?: number;
  supports_reasoning?: boolean;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
  supports_tool_use?: boolean;
  supports_thinking_type?: "only" | "no" | "both";
};

// A model that survived id-filtering (static list, cache validation, or the
// /models fetch filter).
export type DiscoveredModel = UpstreamModel & { id: string };

// OpenCode's model-config modality literals.
export type Modality = "text" | "audio" | "image" | "video" | "pdf";

export type OAuthRecord = { type: "oauth"; access: string; refresh: string; expires: number };

export type ModelCache = { ts: number; models: DiscoveredModel[] };

// Device-authorization response shape (subset we use).
export type DeviceAuthorization = {
  device_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  expires_in?: number;
  interval?: number;
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

// token response -> OpenCode OAuth record (expires in ms)
export function toAuth(data: Record<string, any>, now = Date.now()): OAuthRecord {
  return {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: now + Number(data.expires_in || 900) * 1000,
  };
}

// Map an upstream model to OpenCode's provider-config model shape.
export function toConfigModel(m: DiscoveredModel) {
  const input: Modality[] = ["text"];
  if (m.supports_image_in) input.push("image");
  if (m.supports_video_in) input.push("video");

  return {
    name: m.display_name || m.id,
    limit: { context: Number(m.context_length) || 262_144, output: DEFAULT_OUTPUT_LIMIT },
    reasoning: !!m.supports_reasoning || m.supports_thinking_type === "only" || m.supports_thinking_type === "both",
    tool_call: m.supports_tool_use !== false,
    attachment: !!(m.supports_image_in || m.supports_video_in),
    // `attachment` alone is not enough: OpenCode gates what it will actually
    // send on `modalities.input`, which defaults to text-only. Without this an
    // image-capable model still has its attachments dropped before the request
    // is built, and it replies that it cannot read images.
    modalities: { input, output: ["text"] as Modality[] },
    // kimi coding models only accept temperature === 1; hide the knob.
    temperature: false,
  };
}

export type PollResult =
  | { kind: "success"; data: Record<string, any> }
  | { kind: "pending"; err: string }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; status: number; data: Record<string, any> };

// Classify one poll of the device-flow token endpoint (RFC 8628).
export function classifyPollResponse(status: number, data: Record<string, any>): PollResult {
  if (status === 200 && data.access_token) return { kind: "success", data };
  const err = data.error || "";
  if (err === "authorization_pending" || err === "slow_down") return { kind: "pending", err };
  if (err === "access_denied") return { kind: "denied" };
  if (err === "expired_token") return { kind: "expired" };
  return { kind: "error", status, data };
}

// kimi coding models only accept temperature === 1; rewrite a JSON request
// body that says otherwise (top-level key only). Non-string and non-JSON
// bodies pass through untouched.
export function pinTemperature(body: RequestInit["body"]): RequestInit["body"] {
  if (typeof body !== "string" || !body.includes('"temperature"')) return body;
  try {
    const o = JSON.parse(body);
    if (o && o.temperature !== undefined && o.temperature !== 1) {
      o.temperature = 1;
      return JSON.stringify(o);
    }
  } catch {}
  return body;
}

// Usable cache file shape: non-empty model list where every entry has an id.
// (`ts` is not validated; a missing one just reads as stale.)
export function isValidModelCache(c: any): c is ModelCache {
  return Array.isArray(c?.models) && c.models.length > 0 && c.models.every((m: any) => m && m.id);
}
