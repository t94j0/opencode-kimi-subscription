// Unit tests for the pure helpers in src/internal.ts (run against the build).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RefreshError,
  classifyPollResponse,
  errorMessage,
  isValidModelCache,
  pinTemperature,
  toAuth,
  toConfigModel,
} from "../dist/internal.js";

describe("pinTemperature", () => {
  it("passes a missing body through", () => {
    assert.equal(pinTemperature(undefined), undefined);
  });
  it("passes a non-string body through untouched", () => {
    const body = new URLSearchParams({ temperature: "0" });
    assert.equal(pinTemperature(body), body);
  });
  it("returns a string without a temperature key as-is", () => {
    const body = JSON.stringify({ model: "k3", messages: [] });
    assert.equal(pinTemperature(body), body);
  });
  it("leaves a non-JSON string mentioning temperature unchanged", () => {
    const body = 'this "temperature" is not JSON';
    assert.equal(pinTemperature(body), body);
  });
  it("leaves temperature === 1 unchanged", () => {
    const body = JSON.stringify({ temperature: 1 });
    assert.equal(pinTemperature(body), body);
  });
  it("rewrites temperature !== 1 to 1, preserving sibling fields", () => {
    const out = JSON.parse(pinTemperature(JSON.stringify({ model: "k3", temperature: 0, max_tokens: 5 })));
    assert.deepEqual(out, { model: "k3", temperature: 1, max_tokens: 5 });
  });
  it("only rewrites the top-level temperature key", () => {
    const body = JSON.stringify({ options: { temperature: 0 } });
    assert.equal(pinTemperature(body), body);
  });
});

describe("toAuth", () => {
  it("maps the token response with expires in ms from an injected now", () => {
    const auth = toAuth({ access_token: "A", refresh_token: "R", expires_in: 900 }, 1_000);
    assert.deepEqual(auth, { type: "oauth", access: "A", refresh: "R", expires: 1_000 + 900_000 });
  });
  it("defaults a missing expires_in to 900s", () => {
    assert.equal(toAuth({ access_token: "A", refresh_token: "R" }, 0).expires, 900_000);
  });
  it("coerces a string expires_in", () => {
    assert.equal(toAuth({ access_token: "A", refresh_token: "R", expires_in: "60" }, 0).expires, 60_000);
  });
});

describe("toConfigModel", () => {
  it("falls back to the id when display_name is missing", () => {
    assert.equal(toConfigModel({ id: "k3" }).name, "k3");
  });
  it("defaults limits when context_length is missing", () => {
    assert.deepEqual(toConfigModel({ id: "k3" }).limit, { context: 262_144, output: 65_536 });
  });
  it("derives reasoning from supports_reasoning or thinking type", () => {
    assert.equal(toConfigModel({ id: "m", supports_reasoning: true }).reasoning, true);
    assert.equal(toConfigModel({ id: "m", supports_thinking_type: "only" }).reasoning, true);
    assert.equal(toConfigModel({ id: "m", supports_thinking_type: "both" }).reasoning, true);
    assert.equal(toConfigModel({ id: "m", supports_thinking_type: "no" }).reasoning, false);
    assert.equal(toConfigModel({ id: "m" }).reasoning, false);
  });
  it("disables tool_call only on explicit supports_tool_use === false", () => {
    assert.equal(toConfigModel({ id: "m", supports_tool_use: false }).tool_call, false);
    assert.equal(toConfigModel({ id: "m" }).tool_call, true);
  });
  it("derives attachment from image or video input support", () => {
    assert.equal(toConfigModel({ id: "m", supports_image_in: true }).attachment, true);
    assert.equal(toConfigModel({ id: "m", supports_video_in: true }).attachment, true);
    assert.equal(toConfigModel({ id: "m" }).attachment, false);
  });
  it("mirrors input support into modalities so OpenCode actually sends them", () => {
    assert.deepEqual(toConfigModel({ id: "m", supports_image_in: true }).modalities.input, ["text", "image"]);
    assert.deepEqual(toConfigModel({ id: "m", supports_video_in: true }).modalities.input, ["text", "video"]);
    assert.deepEqual(toConfigModel({ id: "m", supports_image_in: true, supports_video_in: true }).modalities.input, [
      "text",
      "image",
      "video",
    ]);
  });
  it("keeps modalities text-only when the model has no image/video input", () => {
    assert.deepEqual(toConfigModel({ id: "m" }).modalities.input, ["text"]);
  });
  it("always reports text output", () => {
    assert.deepEqual(toConfigModel({ id: "m", supports_image_in: true }).modalities.output, ["text"]);
  });
  it("always hides the temperature knob", () => {
    assert.equal(toConfigModel({ id: "m" }).temperature, false);
  });
});

describe("classifyPollResponse", () => {
  it("classifies a token response as success", () => {
    const r = classifyPollResponse(200, { access_token: "A" });
    assert.equal(r.kind, "success");
    assert.equal(r.data.access_token, "A");
  });
  it("treats 200 without an access_token as an error, not success", () => {
    assert.equal(classifyPollResponse(200, {}).kind, "error");
  });
  it("classifies authorization_pending and slow_down as pending, preserving err", () => {
    assert.deepEqual(classifyPollResponse(400, { error: "authorization_pending" }), {
      kind: "pending",
      err: "authorization_pending",
    });
    assert.deepEqual(classifyPollResponse(400, { error: "slow_down" }), { kind: "pending", err: "slow_down" });
  });
  it("classifies access_denied and expired_token", () => {
    assert.equal(classifyPollResponse(400, { error: "access_denied" }).kind, "denied");
    assert.equal(classifyPollResponse(400, { error: "expired_token" }).kind, "expired");
  });
  it("carries status and data on unknown errors", () => {
    const r = classifyPollResponse(500, { error: "server_error" });
    assert.equal(r.kind, "error");
    assert.equal(r.status, 500);
    assert.equal(r.data.error, "server_error");
  });
});

describe("errorMessage", () => {
  it("uses .message for Error instances and String() otherwise", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage("plain"), "plain");
    assert.equal(errorMessage(42), "42");
  });
});

describe("RefreshError", () => {
  it("carries the HTTP status and narrows via instanceof", () => {
    const err = new RefreshError("token refresh failed (HTTP 401)", 401);
    assert.ok(err instanceof RefreshError);
    assert.ok(err instanceof Error);
    assert.equal(err.status, 401);
  });
});

describe("isValidModelCache", () => {
  it("accepts a non-empty model list where every entry has an id", () => {
    assert.equal(isValidModelCache({ ts: 1, models: [{ id: "k3" }] }), true);
  });
  it("rejects empty, id-less, or malformed caches", () => {
    assert.equal(isValidModelCache({ ts: 1, models: [] }), false);
    assert.equal(isValidModelCache({ ts: 1, models: [{ display_name: "no id" }] }), false);
    assert.equal(isValidModelCache({ models: "nope" }), false);
    assert.equal(isValidModelCache(null), false);
  });
});
