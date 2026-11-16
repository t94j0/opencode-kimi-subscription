# opencode-kimi-subscription

Use your Kimi Code subscription in [OpenCode](https://opencode.ai) through
Kimi's OAuth device flow. The plugin registers the provider and its models,
adds a browser sign-in method, and lets OpenCode manage token refresh. It
obtains its own credentials and does not read or modify `~/.kimi-code`.

This version targets OpenCode 2.3.0 and the `@opencode/plugin` V2 API.
OpenCode V1 is not supported. Building from source requires Node.js 20 or later.

## Install

From the repository directory, install dependencies and build the plugin:

```sh
npm install
npm run build
```

Add the repository's absolute directory path to `plugins` in your global
`~/.config/opencode/opencode.json` or project `opencode.json`. Keep any other
plugins already listed. This example selects the international Kimi service:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-kimi-subscription",
      "options": { "region": "global" }
    }
  ]
}
```

The path must point to the repository directory, not `dist/index.js`.
For a published V2-compatible release, replace the directory in `package`
with its npm package name and version. Version 0.1.x uses the V1 plugin API.

Restart OpenCode, open `/connect`, and select **Kimi Code (Global subscription)**.
Approve the device sign-in in your browser, then choose a model under that
provider in `/models`. No manual `provider` block or API key is required.

## Choose a region

Set `options.region` to match the service where you use Kimi Code:

| Region | Provider and integration ID | OAuth host | API base |
| --- | --- | --- | --- |
| `global` | `kimi-code-global` | `https://auth.kimi.ai` | `https://api.kimi.ai/coding/v1` |
| `mainland-cn` | `kimi-code` | `https://auth.kimi.com` | `https://api.kimi.com/coding/v1` |

For mainland China, use `"region": "mainland-cn"` and select **Kimi Code
(China subscription)** in `/connect`. If no region or recognized endpoint
override is set, the plugin defaults to `mainland-cn` for compatibility with
existing configurations.

The regions have separate credentials and model caches. When changing regions,
update the plugin entry, restart OpenCode, and sign in to the selected region.
Credentials from one region are not copied to the other. Select the new
provider in `/models` as well.

When upgrading from the V1 plugin, rename the config key `plugin` to `plugins`
and replace any single-file plugin path with the repository directory.
Use `/connect` if OpenCode cannot find your previous sign-in.

## Configuration

The region option sets both OAuth and API endpoints. Environment variables can
override them, for example when using a local test server or a proxy:

| Variable | Purpose |
| --- | --- |
| `KIMI_CODE_BASE_URL` | Override the selected region's API base URL |
| `KIMI_CODE_OAUTH_HOST` | Override the selected region's OAuth host |
| `KIMI_OAUTH_HOST` | Fallback when `KIMI_CODE_OAUTH_HOST` is unset |
| `KIMI_SUBSCRIPTION_CACHE` | Override the model cache file path |

An official endpoint override also selects its region when `options.region`
is absent. An explicit region must agree with official endpoint overrides;
mixing `.ai` and `.com` endpoints is rejected. Custom hosts use the explicitly
selected region, or `mainland-cn` when none is selected.

A user-defined `provider.kimi-code-global` or `provider.kimi-code` takes
precedence over the plugin's provider definition for that region. The plugin
still registers its sign-in method and temperature hooks.

## How it works

The provider uses `@opencode/ai/providers/openai-compatible`. Its initial model
list comes from a cache, or a static fallback containing K3 and Kimi coding
models. After a successful sign-in, the plugin fetches `/models`. At startup
and every six hours it also checks for a stale cache and refreshes it when a
signed-in connection is available. A nonempty response updates the cache and
reloads the provider; an error leaves the current model list in place.

Caches are stored under `$XDG_CACHE_HOME/opencode-kimi-subscription`, or
`~/.cache/opencode-kimi-subscription` by default: `models.json` for mainland
China and `models-global.json` for global. Each new cache record identifies its
region, including when using a custom cache path. Legacy records without a
region are accepted only for mainland China.

OpenCode stores OAuth credentials, injects the Bearer token, and calls the
plugin's refresh method before the access token expires. OpenCode also saves
rotated refresh tokens. The plugin sets `temperature: 1` for conversation,
compaction, session generation, and title requests. Unloading the plugin stops
its timer and aborts outstanding OAuth and model-discovery requests.

## Troubleshooting

- **Provider missing:** rebuild the plugin and check that `package` points to
  the repository directory. Use OpenCode 2.3.0 with the `plugins` config key.
- **Wrong sign-in site:** check `options.region` and any endpoint environment
  variables. International accounts use `global` (`kimi.ai`).
- **Region conflict on startup:** remove conflicting endpoint overrides or
  make them agree with the selected region.
- **Expired sign-in or HTTP 401/403:** reconnect through `/connect`. The plugin
  does not force a token refresh after an upstream authentication rejection.
- **Model discovery fails:** the existing cache or static model list remains
  available. Cache failures are logged with a `[kimi-subscription]` prefix.

## Development

`src/index.ts` contains plugin setup, OAuth device polling and refresh, model
discovery, and lifecycle cleanup. `src/internal.ts` contains region selection,
response validation, and model mapping. Unit and smoke tests use mocked APIs.

```sh
npm run ci
```

This runs lint, formatting, type checking, the build, and offline tests. To test
against a real OpenCode 2.3.0 executable, run both regional scenarios after
building:

```sh
OPENCODE_BIN=/path/to/opencode npm run test:integration
OPENCODE_BIN=/path/to/opencode KIMI_TEST_REGION=global npm run test:integration
```

The integration test starts an isolated OpenCode server and local fake Kimi
endpoints. It checks plugin loading, device sign-in, token refresh, and streamed
completions without using personal credentials or subscription quota. Set
`OPENCODE_PLUGIN_PATH` to an installed package directory to test a packaged build.
