import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RefreshError,
  classifyPollResponse,
  errorMessage,
  isValidModelCache,
  resolveRegion,
  toCredential,
  toModelInfo,
} from "../dist/internal.js";

describe("OAuth response mapping", () => {
  it("keeps the rotated tokens and converts expiry to milliseconds", () => {
    assert.deepEqual(toCredential({ access_token: "A", refresh_token: "R", expires_in: "60" }, 1_000), {
      type: "oauth",
      methodID: "device",
      access: "A",
      refresh: "R",
      expires: 61_000,
    });
  });

  it("rejects missing tokens and invalid expiry", () => {
    for (const data of [
      { refresh_token: "R" },
      { access_token: "A" },
      { access_token: " ", refresh_token: "R" },
      { access_token: "A", refresh_token: "R", expires_in: 0 },
      { access_token: "A", refresh_token: "R", expires_in: "abc" },
    ])
      assert.throws(() => toCredential(data));
  });

  it("classifies RFC 8628 poll outcomes", () => {
    assert.equal(classifyPollResponse(200, { access_token: "A" }).kind, "success");
    assert.equal(classifyPollResponse(200, {}).kind, "error");
    assert.deepEqual(classifyPollResponse(400, { error: "slow_down" }), { kind: "pending", err: "slow_down" });
    assert.deepEqual(classifyPollResponse(400, { error: "authorization_pending" }), {
      kind: "pending",
      err: "authorization_pending",
    });
    assert.equal(classifyPollResponse(400, { error: "access_denied" }).kind, "denied");
    assert.equal(classifyPollResponse(400, { error: "expired_token" }).kind, "expired");
  });
});

describe("model mapping", () => {
  it("keeps tool, image, and video capabilities separate", () => {
    const model = toModelInfo(
      { id: "m", supports_tool_use: false, supports_video_in: true, context_length: 1234 },
      "kimi-code",
    );
    assert.equal(model.providerID, "kimi-code");
    assert.equal(model.limit.context, 1234);
    assert.equal(model.limit.output, 65_536);
    assert.equal(model.capabilities.tools, false);
    assert.deepEqual(model.capabilities.input, ["text", "video"]);
    assert.equal(model.capabilities.temperature, false);
    assert.deepEqual(toModelInfo({ id: "m", supports_image_in: true }, "kimi-code-global").capabilities.input, [
      "text",
      "image",
    ]);
    assert.equal(toModelInfo({ id: "m" }, "kimi-code-global").providerID, "kimi-code-global");
  });

  it("uses safe fallbacks for missing metadata", () => {
    const model = toModelInfo({ id: "m", context_length: "bad" }, "kimi-code");
    assert.equal(model.name, "m");
    assert.equal(model.limit.context, 262_144);
    assert.equal(model.capabilities.tools, true);
  });

  it("accepts only a nonempty inventory with nonempty string IDs", () => {
    assert.equal(isValidModelCache({ models: [{ id: "k3" }] }), true);
    for (const models of [[], [{}], [{ id: 42 }], [{ id: " " }]]) {
      assert.equal(isValidModelCache({ models }), false);
    }
    assert.equal(isValidModelCache({ region: "mainland-cn", models: [{ id: "k3" }] }, "global"), false);
    assert.equal(isValidModelCache({ models: [{ id: "k3" }] }, "global"), false);
    assert.equal(isValidModelCache({ region: "global", models: [{ id: "k3" }] }, "global"), true);
  });
});

describe("region selection", () => {
  it("keeps China as the compatibility default and selects global explicitly", () => {
    const china = resolveRegion({}, {});
    const global = resolveRegion({ region: "global" }, {});
    assert.deepEqual(
      [china.region, china.providerID, china.oauthHost, china.apiBase],
      ["mainland-cn", "kimi-code", "https://auth.kimi.com", "https://api.kimi.com/coding/v1"],
    );
    assert.deepEqual(
      [global.region, global.integrationID, global.oauthHost, global.apiBase],
      ["global", "kimi-code-global", "https://auth.kimi.ai", "https://api.kimi.ai/coding/v1"],
    );
  });

  it("infers global from a known .ai endpoint and keeps custom proxy hosts", () => {
    assert.equal(resolveRegion({}, { KIMI_CODE_OAUTH_HOST: "https://auth.kimi.ai" }).region, "global");
    assert.equal(
      resolveRegion({}, { KIMI_CODE_BASE_URL: "https://api.kimi.ai/coding/v1" }).oauthHost,
      "https://auth.kimi.ai",
    );
    const custom = resolveRegion({ region: "global" }, { KIMI_CODE_OAUTH_HOST: "http://127.0.0.1:1234" });
    assert.equal(custom.apiBase, "https://api.kimi.ai/coding/v1");
    assert.equal(custom.oauthHost, "http://127.0.0.1:1234");
  });

  it("rejects invalid, mixed, and contradictory region choices", () => {
    assert.throws(() => resolveRegion({ region: "mars" }, {}), /region must/);
    assert.throws(
      () => resolveRegion({ region: "global" }, { KIMI_CODE_OAUTH_HOST: "https://auth.kimi.com" }),
      /conflicts/,
    );
    assert.throws(
      () =>
        resolveRegion(
          {},
          {
            KIMI_CODE_OAUTH_HOST: "https://auth.kimi.com",
            KIMI_CODE_BASE_URL: "https://api.kimi.ai/coding/v1",
          },
        ),
      /different regions/,
    );
  });
});

it("keeps errors inspectable", () => {
  const error = new RefreshError("failed", 401);
  assert.equal(error.status, 401);
  assert.equal(errorMessage(error), "failed");
});
