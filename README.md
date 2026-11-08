# opencode-kimi-subscription (local fork)

Use your Kimi Code (Moonshot) **subscription** in
[OpenCode](https://opencode.ai) 2.x: sign in with Kimi's OAuth device flow and
spend your subscription instead of pay-as-you-go API tokens.

> **Fork note** — this is a local port of
> [`t94j0/opencode-kimi-subscription`](https://github.com/t94j0/opencode-kimi-subscription)
> (MIT, v0.1.0) to the **OpenCode 2.x plugin API** (`Plugin.define` from
> `@opencode/plugin`), targeting OpenCode **2.2.x**. The upstream v0.1.0
> targets the V1 API (default-exported async function) and fails to load on
> 2.x with `Plugin must export a default definition with an id and an effect
> or setup function`. Everything below is the V2 design.

OpenCode's built-in "Kimi For Coding" providers only cover pay-as-you-go API
keys; this plugin adds the subscription path. It self-registers the
`kimi-code` provider and its models, adds a "Sign in with Kimi (subscription)"
device-flow method to the `kimi-code` integration, and keeps the short-lived
(15 min) access token fresh via the V2 `refresh` callback. It obtains its own
device token and never touches `~/.kimi-code`, so the official `kimi` CLI
keeps working alongside it.

## Install (local)

Add the repo path to your OpenCode config
(`~/.config/opencode/opencode.json` or a project `opencode.json`). Run
`npm install && npm run build` in the repo first (needs `node_modules` for the
`@opencode/plugin` import).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["d:/AI_PetProjects/opencode-kimi-subscription"]
}
```

When this fork (or a V2-compatible upstream release) is published to npm, the
spec can become `"opencode-kimi-subscription"` again.

Then sign in:

```
opencode          # /connect → kimi-code → "Sign in with Kimi (subscription)"
                  # approve the device flow in the browser (kimi.com)
                  # /models → Kimi Code (subscription) → K3 / K2.7 Coding / …
```

That's the only manual step; you don't need to add a `provider` block.

## How it works (V2)

Derived from the official `kimi` CLI (v0.26.0):

|                         |                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (OpenAI-compatible) | `https://api.kimi.com/coding/v1` — `POST /chat/completions`                                                                                          |
| OAuth host              | `https://auth.kimi.com`                                                                                                                              |
| Login                   | Device Authorization Grant (RFC 8628): `POST /api/oauth/device_authorization` → approve at `kimi.com/code/authorize_device` → poll `POST /api/oauth/token` |
| Refresh                 | `POST /api/oauth/token` (`grant_type=refresh_token`); rotates the refresh token                                                                      |
| Client ID               | `17e5f671-d194-4dfb-9706-5516cb48c098`                                                                                                               |

1. **`ctx.provider.transform`** — registers the `kimi-code` provider
   (`@opencode/ai/providers/openai-compatible`, `settings.baseURL` → kimi
   coding endpoint) with the model list, unless you've defined your own
   `provider.kimi-code` in config (then it's respected as-is). The transform
   closes over the current model list, so `ctx.provider.reload()` after a
   model sync picks up new models.
2. **`ctx.integration.transform`** — registers the OAuth **device-flow**
   method on the `kimi-code` integration (`authorize` runs RFC 8628 against
   Kimi; `refresh` exchanges the rotating refresh token when the 15-min
   access token expires). OpenCode's core injects the Bearer token itself.
3. **Session hooks** (scoped to `kimi-code`):
   - `context` — pins `temperature: 1` on every request (kimi coding models
     reject any other value);
   - `retry` — one retry on 401/403 (expired-token race: the core refreshes
     the credential, we give it one more attempt).
4. **Model discovery** — an on-disk cache
   (`~/.cache/opencode-kimi-subscription/models.json`, 6 h TTL) refreshed from
   the live `/models` list at startup, after sign-in, and on a 6 h timer
   (whenever a signed-in credential is available). A static baseline
   (K3, K2.7 Coding, K2.7 Coding Highspeed) seeds the provider before the
   first sync.

## Configuration

Environment variables (rarely needed):

| Var                                        | Default                          |
| ------------------------------------------ | -------------------------------- |
| `KIMI_CODE_BASE_URL`                       | `https://api.kimi.com/coding/v1` |
| `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` | `https://auth.kimi.com`          |
| `KIMI_SUBSCRIPTION_CACHE`                  | `~/.cache/opencode-kimi-subscription/models.json` |

To override models or the provider, define `provider.kimi-code` yourself in
`opencode.json` — the plugin won't overwrite it.

## Debugging

The plugin logs its lifecycle with a `[kimi-subscription]` prefix:

```
opencode --print-logs --log-level DEBUG
# or: tail -f ~/.local/share/opencode/log/opencode.log | grep kimi
```

Common issues:

- **Provider missing from `/models`** — check the log for
  `[kimi-subscription] error/failed to load plugin`; make sure the repo
  `node_modules` exists (`npm install`) and the config points at the repo root.
- **`not logged in`** — run `/connect` in the TUI and pick
  _Kimi Code (subscription)_.
- **Refresh fails / re-login needed** — the 30-day refresh token lapsed;
  log in again.
- Inspect the stored token with `opencode auth list`; remove it with
  `opencode auth logout kimi-code`.

## Development

```
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # unit + smoke (no network)
KIMI_INTEGRATION=1 node test/integration.mjs   # live device-flow endpoint check (opt-in)
```
