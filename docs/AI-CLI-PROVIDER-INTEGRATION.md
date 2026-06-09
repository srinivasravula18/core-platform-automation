# AI CLI Provider Integration

This app supports two AI provider auth modes from **Settings -> AI Providers**:

- `API key`: the backend calls provider SDKs directly.
- `Subscription / account`: the backend shells out to an already-authenticated local CLI.

The local CLI mode is used for subscription-backed tools:

- OpenAI -> `codex exec`
- Anthropic -> `claude -p`

CLI account mode is **local-development only**. In test and production environments, the backend refuses account-mode providers and requires API-key providers.

## Files

- `server/ai/providers/cli.ts`
  Implements `AccountCliProvider`, the local CLI-backed provider.
- `server/ai/orchestrator.ts`
  Chooses SDK providers or CLI providers based on `providerSettings[provider].authMode`.
- `server/features/settings/aiRoutes.ts`
  Exposes provider settings, health checks, auth mode, enabled state, and model choices.
- `server/shared/storage.ts`
  Defines persisted provider settings defaults.
- `src/pages/Settings.tsx`
  Renders provider cards, API key/account mode controls, model dropdowns, and On/Off buttons.

## Persisted Settings Shape

Settings are saved in `.testflow-settings.json`:

```json
{
  "providerSettings": {
    "openai": {
      "apiKey": "",
      "model": "gpt-5.4-mini",
      "authMode": "account",
      "enabled": true
    },
    "anthropic": {
      "apiKey": "",
      "model": "claude-sonnet-4-6",
      "authMode": "account",
      "enabled": false
    }
  },
  "defaultProvider": "openai"
}
```

`enabled` controls whether a provider can be used by agents. Disabled providers are ignored by `resolveProviderForAgent`.

## OpenAI / Codex Account Mode

OpenAI account mode maps to:

```powershell
codex.cmd exec --cd <repo> --sandbox read-only --color never --output-last-message <tmp-file> -
```

The prompt is passed on stdin. The final answer is read from the temporary `--output-last-message` file.

Before using it in the app, verify locally:

```powershell
codex.cmd login status
codex.cmd exec --cd D:\core-platform-automation --sandbox read-only --color never "Reply with OK only."
```

Expected result:

```text
Logged in using ChatGPT
OK
```

Important Windows detail: the Node backend launches `codex.cmd` with `shell: true`; otherwise Node can fail with `spawn EINVAL`.

Important nested-Codex detail: if the backend is started from inside a Codex session, it may inherit internal Codex environment variables. The CLI runner strips these before launching nested `codex exec`:

```ts
delete env.CODEX_THREAD_ID;
delete env.CODEX_SANDBOX_NETWORK_DISABLED;
delete env.CODEX_MANAGED_BY_NPM;
delete env.CODEX_MANAGED_PACKAGE_ROOT;
```

Without that cleanup, `codex exec` can choose the wrong auth/runtime path and fail with `401 Unauthorized` against `api.openai.com`.

## Anthropic / Claude Account Mode

Anthropic account mode maps to:

```powershell
claude.exe -p --model <selected-model> --permission-mode dontAsk --output-format text "<prompt>"
```

Before using it in the app, verify locally:

```powershell
claude.exe -p --permission-mode dontAsk --output-format text "Reply with OK only."
```

Expected result:

```text
OK
```

The model selected in Settings is passed to Claude with `--model`. For example:

- `claude-opus-4-8`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

If the local Claude subscription does not allow a selected model, Claude CLI returns the provider error.

## Provider Resolution

`resolveProviderForAgent(agent)` works like this:

1. Use the per-agent provider if configured and enabled.
2. Otherwise use the default provider if enabled.
3. Otherwise use the first enabled configured provider.
4. Otherwise fall back to the preferred provider name and fail during provider construction.

This means turning providers Off in Settings prevents accidental fallback.

## Health Checks

Settings uses:

```http
POST /api/ai/providers/:name/test
```

For account mode, this calls the local CLI with a small prompt:

```text
Reply with OK only.
```

The result must contain `OK` to be considered healthy.

## Structured Output

The app still expects structured JSON for many agent tasks. `AccountCliProvider.generateObject` asks the CLI model to return JSON only, then validates against the Zod schema.

The CLI provider also normalizes common model response shapes:

- bare arrays
- `{ playwright_scripts: [...] }`
- `{ tests: [...] }`
- `{ items: [...] }`

This is needed because script generation expects:

```json
{ "scripts": [] }
```

## Troubleshooting

### Codex says doctor is OK but app test fails

Run:

```powershell
codex.cmd login status
codex.cmd exec --cd D:\core-platform-automation --sandbox read-only --color never "Reply with OK only."
```

`codex doctor` can show cached tokens, but `codex exec` is the path the app uses. Fix `codex exec` first.

### Codex returns 401 Unauthorized

Check whether the backend inherited Codex runtime env vars. The runner strips the known problematic vars. If a new Codex env var causes trouble, add it to the cleanup block in `server/ai/providers/cli.ts`.

### Node returns spawn EINVAL on Windows

Use `shell: true` for `.cmd` or `.bat` commands. This is already handled in `runProcess`.

### Claude works in terminal but fails in app

Verify `claude.exe` is discoverable from the backend process PATH:

```powershell
where.exe claude
```

Then test:

```powershell
claude.exe -p --permission-mode dontAsk --output-format text "Reply with OK only."
```

### Provider is configured but not used

Check that it is turned `On` in Settings. Disabled providers are intentionally ignored.

## Adding Another CLI Provider

1. Add the provider name to `ProviderName` in `server/ai/providers/types.ts`.
2. Add default model entries in `DEFAULT_MODELS`.
3. Add Settings labels in `src/pages/Settings.tsx`.
4. Add a CLI tool type and command in `server/ai/providers/cli.ts`.
5. Map the provider in `buildProvider` inside `server/ai/orchestrator.ts`.
6. Add UI/API support in `server/features/settings/aiRoutes.ts`.
7. Verify with `/api/ai/providers/:name/test`.

Keep CLI account mode local-only. Do not expose it to public or untrusted hosted environments.

## Environment Gate

`server/ai/orchestrator.ts` allows account-mode CLI providers only when:

- `NODE_ENV` is empty, `development`, or `dev`; or
- `ALLOW_LOCAL_CLI_PROVIDERS=true` is explicitly set.

In `test`, `production`, or other non-local environments, account mode throws:

```text
CLI providers are disabled outside local development. Use API key mode in test and production.
```

This is intentional. Local CLI auth depends on a developer's machine-level Codex/Claude login and should not be used in shared test runners or production deployments.
