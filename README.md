# opencode-kimi-subscription

Use your Kimi Code (Moonshot) subscription in [OpenCode](https://opencode.ai):
sign in with Kimi's OAuth device flow and spend your subscription instead of
pay-as-you-go API tokens.

OpenCode's built-in "Kimi For Coding" provider covers pay-as-you-go API keys.
This plugin covers the other path — a Kimi Code subscription — which OpenCode
doesn't support out of the box. It adds a "Sign in with Kimi (subscription)"
method to `opencode auth login`, refreshes the short-lived access token
transparently, and self-registers the `kimi-code` provider. Models are
discovered from the live `/models` endpoint and cached, so new Kimi models
appear automatically, with a static baseline (K3, Kimi K2.7 Coding, Kimi K2.7
Coding Highspeed) as the fallback. The plugin obtains its own device token and
never touches `~/.kimi-code`, so the official `kimi` CLI keeps working
alongside it.

## Install

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json` or a
project `opencode.json`); OpenCode installs npm plugins automatically at startup.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-subscription"]
}
```

Then sign in:

```
opencode auth login      # choose "Kimi Code (subscription)", approve in the browser
opencode                 # /models → Kimi Code (subscription) → K3
```

That's the only manual step; you don't need to add a `provider` block.

To run from source instead:

```
git clone https://github.com/t94j0/opencode-kimi-subscription
cd opencode-kimi-subscription && npm install && npm run build
```

```json
{ "plugin": ["/absolute/path/to/opencode-kimi-subscription/dist/index.js"] }
```

## How it works

Derived from the official `kimi` CLI (v0.26.0):

|                         |                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (OpenAI-compatible) | `https://api.kimi.com/coding/v1` — `POST /chat/completions`                                                                                          |
| OAuth host              | `https://auth.kimi.com`                                                                                                                              |
| Login                   | Device Authorization Grant (RFC 8628): `POST /api/oauth/device_authorization` → approve at `kimi.com/code/authorize_device` → poll `POST /api/oauth/token` |
| Refresh                 | `POST /api/oauth/token` (`grant_type=refresh_token`); rotates the refresh token                                                                      |
| Client ID               | `17e5f671-d194-4dfb-9706-5516cb48c098`                                                                                                               |

1. **`config` hook** — injects the `kimi-code` provider (`@ai-sdk/openai-compatible`)
   and the model list, unless you've defined one yourself.
2. **`auth` hook** — drives the device flow, stores the token in OpenCode's auth
   store, and returns a `fetch` that injects `Authorization: Bearer …`, refreshes
   the token when < 7.5 min remain or on a 401/403, and pins `temperature: 1`
   (these models reject any other value).
3. **Model discovery** — each request refreshes an on-disk cache
   (`~/.cache/opencode-kimi-subscription/models.json`, 6 h TTL) from the live
   `/models` list; the `config` hook reads that cache at startup.

## Configuration

Environment variables (rarely needed):

| Var                                        | Default                          |
| ------------------------------------------ | -------------------------------- |
| `KIMI_CODE_BASE_URL`                       | `https://api.kimi.com/coding/v1` |
| `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` | `https://auth.kimi.com`          |

To override models or the provider name, define `provider.kimi-code` yourself in
`opencode.json` — the plugin won't overwrite it.

## Debugging

The plugin logs its auth lifecycle into OpenCode's log stream (service
`kimi-subscription`); failures that need action also raise a TUI toast.

```
opencode --print-logs --log-level DEBUG
# or: tail -f ~/.local/share/opencode/log/opencode.log | grep kimi
```

Common issues:

- **`not logged in`** — run `opencode auth login` and pick _Kimi Code (subscription)_.
- **Refresh fails / re-login needed** — the 30-day refresh token lapsed; log in again.
- **`invalid temperature`** — a custom provider is sending `temperature ≠ 1`;
  remove it and let the plugin manage the request.
- Inspect the stored token with `opencode auth list`; remove it with
  `opencode auth logout kimi-code`.

## Development

TypeScript (strict), built to plain ESM in `dist/`; no runtime dependencies.

```
npm run build            # tsc -> dist/ (+ .d.ts)
npm run typecheck        # tsc --noEmit
npm run lint             # oxlint
npm run format           # prettier --write   (format:check verifies)
npm test                 # builds, then unit + smoke tests (no network)
npm run ci               # lint + format:check + typecheck + test

KIMI_INTEGRATION=1 npm run build && npm run test:integration   # live API test (needs login)
```

CI runs `npm run ci` on every push and PR (`.github/workflows/ci.yml`).
