// Offline check against an isolated OpenCode 2.3 server and fake Kimi endpoints.
// Run after build: OPENCODE_BIN=/path/to/opencode npm run test:integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client/promise";

assert.ok(process.env.OPENCODE_BIN, "set OPENCODE_BIN to an OpenCode 2.3 executable");
const region = process.env.KIMI_TEST_REGION || "mainland-cn";
assert.ok(region === "mainland-cn" || region === "global", "KIMI_TEST_REGION must be mainland-cn or global");
const providerID = region === "global" ? "kimi-code-global" : "kimi-code";
const root = await mkdtemp(join(tmpdir(), "kimi-runtime-"));
const packagePath = process.env.OPENCODE_PLUGIN_PATH || fileURLToPath(new URL("../", import.meta.url));
const requests = [];
const mock = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push({ path: request.url, authorization: request.headers.authorization, raw });
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/oauth/device_authorization") {
    response.end(
      JSON.stringify({
        device_code: "device",
        verification_uri: "https://example.invalid/authorize",
        expires_in: 60,
        interval: 1,
      }),
    );
  } else if (request.url === "/api/oauth/token") {
    const refresh = new URLSearchParams(raw).get("grant_type") === "refresh_token";
    response.end(
      JSON.stringify({
        access_token: refresh ? "refreshed-access" : "login-access",
        refresh_token: refresh ? "rotated-refresh" : "login-refresh",
        expires_in: 900,
      }),
    );
  } else if (request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "k3", context_length: 1_048_576 }] }));
  } else if (request.url === "/v1/chat/completions") {
    response.setHeader("content-type", "text/event-stream");
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "RUNTIME OK" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "k3", choices: [choice] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(404).end("{}");
  }
});

let child;
try {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const fakeKimi = `http://127.0.0.1:${mock.address().port}`;
  await mkdir(join(root, "config/opencode"), { recursive: true });
  await mkdir(join(root, "project"));
  await writeFile(
    join(root, "config/opencode/opencode.json"),
    JSON.stringify({ plugins: [{ package: packagePath, options: { region } }] }),
  );
  child = spawn(process.env.OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "warn"], {
    cwd: join(root, "project"),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENCODE_"))),
      OPENCODE_TEST_HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_SERVER_PASSWORD: "isolated-test-password",
      KIMI_CODE_BASE_URL: `${fakeKimi}/v1`,
      KIMI_CODE_OAUTH_HOST: fakeKimi,
      KIMI_SUBSCRIPTION_CACHE: join(root, "models.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  await once(child, "spawn");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 200 && !logs.includes("server listening on"); i++) await pause(50);
  const url = logs.match(/server listening on (http:\/\/\S+)/)?.[1];
  assert.ok(url, logs);

  const client = OpenCode.make({
    baseUrl: url,
    headers: { authorization: `Basic ${Buffer.from("opencode:isolated-test-password").toString("base64")}` },
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  const location = { directory: join(root, "project") };
  let own;
  for (let i = 0; i < 100; i++) {
    own = (await client.plugin.list({ location })).data.find((entry) => entry.id === "opencode-kimi-subscription");
    if (own?.state?.status === "active") break;
    await pause(100);
  }
  assert.equal(own?.state?.status, "active", JSON.stringify(own));
  assert.equal(
    (await client.provider.get({ location, providerID })).data.package,
    "@opencode/ai/providers/openai-compatible",
  );
  assert.ok((await client.integration.get({ location, integrationID: providerID })).data);

  const authorization = (
    await client.integration.oauth.connect({ location, integrationID: providerID, methodID: "device" })
  ).data;
  let status;
  for (let i = 0; i < 100; i++) {
    status = (
      await client.integration.oauth.status({
        location,
        integrationID: providerID,
        attemptID: authorization.attemptID,
      })
    ).data;
    if (status.status !== "pending") break;
    await pause(100);
  }
  assert.equal(status.status, "complete", JSON.stringify(status));

  await client.credential.create({
    integrationID: providerID,
    activate: true,
    value: {
      type: "oauth",
      methodID: "device",
      access: "expired",
      refresh: "login-refresh",
      expires: Date.now() - 1000,
    },
  });
  const session = await client.session.create({ location, model: { providerID, id: "k3" } });
  for (let i = 0; i < 2; i++) {
    const result = await client.session.generate({ sessionID: session.id, prompt: "Reply RUNTIME OK" });
    assert.equal(result.text, "RUNTIME OK");
  }
  const completion = requests.find((request) => request.path === "/v1/chat/completions");
  assert.equal(completion?.authorization, "Bearer refreshed-access");
  assert.equal(JSON.parse(completion.raw).temperature, 1);
  assert.equal(JSON.parse(await readFile(join(root, "models.json"), "utf8")).region, region);
  assert.equal(
    requests.filter(
      (request) => request.path === "/api/oauth/token" && request.raw.includes("grant_type=refresh_token"),
    ).length,
    1,
  );
  console.log("OpenCode runtime: plugin, device login, refresh, and completion passed");
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await once(child, "exit").catch(() => {});
    clearTimeout(timer);
  }
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await rm(root, { recursive: true, force: true });
}
