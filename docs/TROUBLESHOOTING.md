# Troubleshooting

**Is the plugin loaded?**

```bash
paseo plugin ls
paseo plugin logs usage-limits
```

`ls` shows configured plugins and their state. `logs` shows retained initialization, cleanup, stderr, and crash output for this plugin. If nothing is listed, check `pluginsEnabled` is `true` and that you ran `paseo reload` after setting it.

**A provider card shows an error.** The card is an error row: the entry resolved (or failed to) but produced no readings, and `error` carries why. Read it top to bottom — the message is written to be the whole diagnosis:

| Error looks like                                       | Cause                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Unknown preset "..."`                                 | Typo in `preset`, or a preset that does not exist. `label` is the config key as a fallback.   |
| A list of `path: message` pairs                        | The entry failed schema validation. Each pair names the offending field.                      |
| `Credential "..." did not resolve ...`                 | Every source in that credential's chain failed. See below.                                    |
| `... (expired 1d ago)` after a source in that list     | That source had a live-looking token whose `expiresAtPath` says it is dead. See below.        |
| `The stored credential was rejected (HTTP 401)`        | The token resolved and the vendor refused it, with nothing stored to fall back to. See below. |
| `<METHOD> request to <host> failed with HTTP 429`      | Rate limited. Not a fault — see [Rate limits](PRESETS.md#rate-limits).                                  |
| `<METHOD> request to <host> failed with HTTP <status>` | The endpoint rejected the request. The body is not quoted; `curl` it to see why.              |
| `<METHOD> request to <host> failed`                    | Network failure, DNS failure, or the 15-second timeout. No status was received.               |
| `<METHOD> request to <host> did not return JSON`       | The endpoint answered 2xx with something that is not JSON — often an HTML login page.         |
| `Command "<binary>" timed out after 15000ms`           | The command ran past 15 seconds and was killed.                                               |
| `Command "<binary>" printed more than 4194304 bytes`   | The command exceeded the 4 MiB stdout cap and was killed.                                     |
| `Command "<binary>" failed`                            | Non-zero exit, or the binary was not found.                                                   |

A source error names only the host or the binary. That is deliberate, not a truncation: the url, headers, argv, and body can all hold an interpolated credential, so none of them is ever printed. If you cannot tell which of two providers on the same host failed, the card's own label tells you.

**The Claude card says rate limited.** Nothing is broken and nothing needs fixing. Anthropic's usage endpoint throttles after very few calls, and the card is showing you the last real reading rather than throwing it away — its timestamp and the retry time are both in the notice. It will refresh itself at that time.

Do not hit refresh. A manual refresh during a backoff issues no request precisely because retrying is what extends the lockout.

If it happens constantly, you have two callers on one budget: this plugin and Paseo's own built-in fetcher behind the Host usage view in Settings, which requests the same endpoint on demand at most once per 5 minutes. Not keeping that view open leaves the budget to the plugin. Raising the provider's `refreshIntervalMs` above 30 minutes also helps, and costs nothing on a 5-hour window:

```json
{ "claude": { "preset": "claude", "refreshIntervalMs": 3600000 } }
```

**The Claude card says the credential expired or was rejected.** Both mean the same thing in practice: the token in `~/.claude/.credentials.json` is no longer good, and this plugin cannot mint a new one — Claude Code owns that file's refresh (see [Expiry](CREDENTIALS.md#expiry)).

Run `claude`. Starting it refreshes `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` in place, which is all the plugin needs. There is nothing to restart: no `paseo reload`, no `paseo plugin reload usage-limits`, no daemon bounce. Credentials are read per fetch, so the card populates on the next successful refresh — hit the surface's refresh action if you do not want to wait out `refreshIntervalMs`.

That reading is then persisted, so it survives a reload and the card comes back with numbers rather than an empty state. It is also why a rejected credential keeps showing real figures with a notice instead of blanking: the last reading on screen is a stored one.

The same applies to any provider reading a CLI's credential file — `codex`, `kimi`, `minimax`. The notice names the file, so run whichever CLI owns it.

**A missing credential.** The error names the credential and lists every source it tried, as descriptions — `env DEEPSEEK_API_KEY`, `file ~/.config/acme/auth.json#tokens.access_token`. Work down that list and fix the one you meant to use. Remember `env` sources read the **daemon's** environment: exporting a variable in your own shell changes nothing unless the daemon was launched from it. An empty or whitespace-only variable counts as a failed source, so an exported-but-blank key presents identically to an unset one.

**Every value is null.** The provider fetched fine but the paths do not match the response. Dump the real document and re-derive them:

```bash
curl -sS -H "Authorization: Bearer $ACME_API_KEY" https://api.example.invalid/v1/usage | jq .
```

Then map each field with dot and bracket syntax, remembering array indices (`balance_infos[0].total_balance`). A path that does not exist is null rather than an error, which is why a whole card of nulls means "wrong paths", not "wrong URL".

**A command source fails.** It must print exactly one JSON document on stdout. Run it by hand and pipe it to `jq .` — anything that makes `jq` complain will break the plugin the same way. Send logs and progress to stderr. A non-zero exit is an error. Time it too: the child is killed at 15 seconds, and stdout is capped at 4 MiB.

**A config edit did nothing.** `usage-limits.json` is read per request, but a provider's result is cached for `refreshIntervalMs`. Use the surface's refresh action to bypass the cache instead of waiting. Note that `paseo plugin reload usage-limits` reloads plugin _code_, not provider config.

**History is empty or short.** Only files modified inside the window are read. A range longer than your retained transcripts shows only what exists. Check that the CLI you expect writes where the reader looks — if you set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for the CLI, the daemon needs the same value in its environment, since the reader resolves those from the daemon's environment.

**History reads low.** Check `scanErrors` first — it names every directory and file the scan could not read, so a permissions problem inside the transcript tree points at itself (see [Scan failures](HISTORY.md#scan-failures)). If `scanErrors` is empty, the scan read everything it could find, and the shortfall is real: either the window is longer than your retained transcripts, or the CLI writes somewhere the reader is not looking.
