# Credentials

Secrets are never written in `usage-limits.json`. Instead a provider **declares** credential names, each with an ordered chain of places to look, and refers to them as `${NAME}` inside `url`, header values, `body` string leaves, `command` entries, and `cwd`.

```json
{
  "credentials": {
    "apiKey": [
      { "kind": "env", "variable": "ACME_API_KEY" },
      { "kind": "jsonFile", "file": "~/.config/acme/auth.json", "path": "tokens.access_token" }
    ]
  }
}
```

| Source kind | Fields                          | Reads                                              |
| ----------- | ------------------------------- | -------------------------------------------------- |
| `env`       | `variable`                      | An environment variable of the **daemon** process. |
| `jsonFile`  | `file`, `path`, `expiresAtPath` | A JSON path inside a file on the daemon machine.   |

A `jsonFile`'s `file` expands a leading `~` to the home directory and `${VAR}` from the daemon environment. That is path expansion, and it is the one place `${...}` means an environment variable rather than a declared credential. An unset variable inside a path is an error rather than a silently mangled path.

Resolution rules:

- The chain is tried in order and the first source that resolves wins.
- A source that fails for **any** reason is skipped and the chain continues: variable unset, variable set but empty or whitespace, file missing, file unreadable, file not JSON, JSON path missing, value empty, value expired (see [Expiry](#expiry)).
- Only when every source fails does it raise `UsageCredentialMissingError`. The message names the credential and **every source it tried** — `env KIMI_TOKEN`, `file ~/.claude/.credentials.json#claudeAiOauth.accessToken` — so the fix is obvious from the error alone.
- There is **no implicit environment fallback**. `${NAME}` where `NAME` is not a declared credential fails immediately, naming the credential and reporting that no sources are configured. To read an environment variable, declare it.
- A resolved value is never sent empty. An empty bearer token would produce a confusing 401 instead of a legible "set the key".

Secrets never appear in errors, in logs, or in the snapshot sent to clients. Error messages carry source _descriptions_ — the variable name, the file path and JSON path — never a resolved value.

Environment variables must be set in the **daemon's** environment, not in whatever shell you are typing in.

## Expiry

A `jsonFile` source may add `expiresAtPath`: a second JSON path, in the same file, to the moment the value at `path` stops working.

```json
{
  "credentials": {
    "token": [
      {
        "kind": "jsonFile",
        "file": "~/.claude/.credentials.json",
        "path": "claudeAiOauth.accessToken",
        "expiresAtPath": "claudeAiOauth.expiresAt"
      }
    ]
  }
}
```

- A timestamp at or **before** now makes that source fail like any other, so the chain moves on to the next source rather than spending the dead token.
- The timestamp reads as an ISO string, epoch seconds, or epoch milliseconds, on the same rule as every other timestamp here: a bare number under 1e11 is seconds, at or above it is milliseconds. Claude Code writes milliseconds.
- Omitting `expiresAtPath` means **no expiry check**, and so does a path that resolves to nothing usable — field absent, `null`, a string that will not parse. An unreadable expiry is deliberately not treated as an expired one: a vendor renaming a field would otherwise lock you out of a credential that still works.
- An `env` source cannot carry it. A variable holds one value with no room for a second, and a key you exported yourself has no expiry to read.

### Why it exists

Claude Code stores its OAuth token in `~/.claude/.credentials.json` at `claudeAiOauth.accessToken`, with `claudeAiOauth.expiresAt` beside it, and it refreshes that pair **only when Claude Code itself runs**. A plugin that only reads the file therefore watches it go stale, and cannot tell from the token alone that it has.

Measured on this machine: the token sat **34 hours past its expiry**. Every refresh spent a request that could only 401 — against `GET https://api.anthropic.com/api/oauth/usage`, the same endpoint that had already answered 429 with `retry-after: 1495` (see [Rate limits](PRESETS.md#rate-limits)). So the cost of not checking is not one wasted request. It is burning a throttled budget on a request whose answer is known in advance, and reading the expiry costs nothing.

**This plugin never refreshes anyone's token.** The agent CLIs own refresh. Minting a new token from a stored refresh token would risk invalidating the CLI's own session, which is a worse failure than a stale card and not this plugin's session to spend. It reads these files and writes to none of them.

### Which presets declare it

| Preset    | `expiresAtPath`                  | On                                                    |
| --------- | -------------------------------- | ----------------------------------------------------- |
| `claude`  | `claudeAiOauth.expiresAt`        | Both `.credentials.json` sources                      |
| `kimi`    | `expires_at`                     | All three `kimi-code.json` sources                    |
| `minimax` | `expires_at`, `oauth.expires_at` | `~/.mmx/credentials.json`, `~/.mmx/config.json` oauth |
| `codex`   | None, deliberately               | —                                                     |

`codex` is the interesting absence. `~/.codex/auth.json` carries `last_refresh`, which records when the token was last refreshed rather than when it dies, so no path in that file can honestly answer the question. A guessed expiry would skip a credential that works, so all three `codex` sources stay two-field. The `~/.mmx/config.json` `api_key` source declares none for the same class of reason: a plain API key has no expiry to read. The `github-copilot` probe reads its own credential file and is in the same position: `hosts.json` records the OAuth token and the login it belongs to, and nothing about when it dies.

### What you see

An expired source is skipped **silently**. It is one source in a chain, and a chain that goes on to succeed is not a failure worth reporting. What changes is the message when the whole chain fails — the source that expired names itself, with its age:

```
Credential "token" did not resolve from file ~/.claude/.credentials.json#claudeAiOauth.accessToken (expired 1d ago)
```

The age is short-formed and floored: minutes under an hour, hours under a day, whole days after that — `0m`, `7m`, `5h`, `1d`, `3d`. The 34-hour token above reads `1d`. An expiry timestamp is not a secret, so it may appear in a message; the value at `path` still never does.

A credential that resolves, passes whatever expiry check it has, and is then **refused** by the vendor is the other half of the same problem. A 401 or 403 is not a transport hiccup you can wait out, so the status stops being the headline. The card keeps its last stored reading, exactly as it does while rate limited, and the notice says what to do:

```
The stored credential was rejected (HTTP 401). Run the CLI that owns ~/.claude/.credentials.json so it refreshes the stored token. Showing the reading from 21 Aug 09:12.
```

The remedy names the CLI that owns the file when the source declares one, and never guesses. `claude` and `codex` set `refreshedBy`; a source without it reads `Run the CLI that owns ~/.claude/.credentials.json so it refreshes the stored token.` A candidate whose path still contains `${...}` is skipped, because an unset variable is the reason that source failed — pointing the user at a path that does not exist names a cause that never happened. The path prints exactly as configured, tilde and all. A provider authenticating from an environment variable gets `Set a current token in OPENROUTER_API_KEY.` instead, one whose key is in the plugin's own secrets file gets `Replace the stored key from the Usage providers screen.`, and one with no credentials at all gets `Re-authenticate this provider.` A 403 behaves identically; any other status is still reported as the plain transport failure. With nothing stored to fall back to there is no reading to show, so the same diagnosis arrives as an error row:

```
The stored credential was rejected (HTTP 401), and no earlier reading is stored yet. Run the CLI that owns ~/.claude/.credentials.json so it refreshes the stored token.
```

## Reading Claude quota without a token

`preset: "claude"` reads the OAuth usage endpoint, so it inherits an access token's lifetime: Claude Code refreshes that token whenever it runs, and the card goes stale only if you do not run it for longer than the token lives. There is a second route with no token at all.

Claude Code passes its own `rate_limits` to a **statusline command** on every turn. A command that writes that object to disk turns the quota into a local document, which `preset: "claude-statusline"` reads through a [`file` source](CONFIGURATION.md#kind-file):

```json
{ "claude": { "preset": "claude-statusline" } }
```

What this buys, over the endpoint preset:

- **No credential.** Nothing to expire, nothing to reject with a 401, and no re-login when a refresh token dies.
- **No request.** The endpoint answers 429 to a second caller — Paseo's own built-in fetcher is one — and this shares nothing with it.
- **Fresher.** The numbers land at the end of every turn, rather than on a thirty-minute poll.

What it costs: **two readings instead of three.** The CLI sends no per-model limits to a statusline, so the `scoped` per-model bucket the endpoint preset reports has no equivalent here. The numbers also only move while Claude Code runs — which is when your quota moves anyway.

Install `statusline-hook.sh`, shipped at the plugin root beside `README.md`, then register it:

```bash
cp statusline-hook.sh ~/.claude/statusline-hook.sh
chmod +x ~/.claude/statusline-hook.sh
```

```json
{ "statusLine": { "type": "command", "command": "~/.claude/statusline-hook.sh" } }
```

in `~/.claude/settings.json`. **Whatever a statusline command prints becomes your status line**, so the shipped script prints one — model, directory, and both windows — rather than blanking it:

```
Opus 5 · paseo-plugins · 5h 42% · 7d 18%
```

It writes `${CLAUDE_CONFIG_DIR:-~/.claude}/paseo-rate-limits.json` through a temporary file and a rename, so the plugin never reads half a document, and it writes the `rate_limits` object **through unchanged**: the preset's reading paths are Claude Code's own field names, `five_hour.utilization` and `five_hour.resets_at`, the same paths the endpoint preset uses. Nothing reshapes or renames anything, which is why a reshaping script that guesses a field name is worse than none — it writes a plausible zero forever.

A session that has no plan quota — an API key, Bedrock or Vertex — sends `rate_limits: null`. The script then leaves the last good file alone, because a quota that does not apply to this session is not news that the quota changed.

Until the hook is registered the card says so, naming both paths it looked in. That is the [`file` source](CONFIGURATION.md#kind-file) error, verbatim.

### Why the plugin will not refresh the token itself

The obvious shortcut — mint a new access token from the refresh token already on disk — is the one thing this plugin must never do. Claude Code's own binary settles it:

- It refreshes against `https://platform.claude.com/v1/oauth/token` and persists `refresh_token` **from the response**, defaulting to the old one only when the response omits it. The server may hand back a new one.
- That write is a compare-and-swap: it only replaces the stored credential while the on-disk refresh token still equals the one it started from, retries three times, and reports `tengu_oauth_token_refresh_lock_compromised_post_post` when it does not. You do not build a CAS against a value that never changes.
- A refresh rejected with `invalid_grant` — the canonical answer for a refresh token that has already been consumed — hits a dedicated path that clears `accessToken`, `refreshToken` and `expiresAt` on disk and forces a re-login.

So a third-party refresh consumes the token Claude Code still has cached, and the _next_ `claude` run, minutes or days later, gets `invalid_grant` and signs the user out. The blast radius lands on the user's own CLI session, not on this plugin. The plugin stays strictly read-only, and the statusline route above is why it does not need to be anything else.
