# Usage Monitor (usage-monitor)

A local Paseo plugin that answers two questions: _how much of my quota is left right now_, and _how many tokens have I burned over the last month_.

## What it contributes

Three sidebar surfaces.

**Usage Monitor** — live provider state, one card per configured provider. Each card renders its readings as bars:

- **quota** — used against a ceiling inside a resetting window (Claude's 5-hour and weekly buckets, per model family). The bar fills as you consume. Where a window has both a reset time and a duration, the bar also marks where even consumption would be, so you can see whether you are ahead of or behind pace.
- **balance** — money or credits left, optionally against a starting total so a percentage means something.
- **rate** — which pricing band is in force right now (peak vs off-peak) and when it changes.

Colour follows the same thresholds as Paseo's own provider meters. A quota over 90% consumed is danger, at or above 70% is warning, below that is neutral. A balance is coloured off what _remains_, inverted: under 10% remaining is danger, under 30% is warning.

A provider that fails to resolve or fails to fetch stays on screen as an error row. It never silently disappears.

Cards are reordered by dragging the grip on the right of a card header, or with the `Move earlier` and `Move later` accessibility actions. Dragging an edge or the corner resizes one card: the right edge changes width, the bottom edge height, the corner both. How a card _renders_ is a provider setting rather than a control on the card itself - see [Card appearance](#card-appearance).

A card can also carry a `notice`: one line saying why its readings are not current. A rate-limited provider keeps its last good readings with their original timestamp and explains itself in the notice rather than discarding real numbers — the surface shows it in the warning colour and marks the card stale. A provider whose credential was rejected does the same. A notice can accompany either a healthy-but-stale card or an error row, so it is independent of `status`. See [Rate limits](#rate-limits) and [Expiry](#expiry).

**Usage history** — cumulative token usage over time as a stacked chart, switchable between 24h, 7d, and 30d. By default each series is one agent CLI. A provider row expands in place to show the models it ran, so the model breakdown appears beside everything else rather than replacing the view; several providers can be open at once. Grouping by model instead lifts every model to the top level, which is the only way to compare two models you reach through different tools.

Series colour is derived from the active theme's accent rather than fixed, so it survives a theme change. Hue separates providers and lightness separates the models inside one provider, which keeps an expanded provider reading as a family instead of as new categories. Every colour is held above the WCAG non-text contrast floor of 3:1 against all three surface colours — see [Colour](#colour).

It plots **Work** (input + output tokens) by default, with Cached, Total and Cost also selectable. Cache re-reads are 99.5% of the raw token total on real transcripts, so a single "tokens" figure reads as work performed when it mostly is not — see [Which metric, and why work is the default](#which-metric-and-why-work-is-the-default). Cost prices each turn from the vendor's own reported figure where a log carries one and from a cached public rate table otherwise, and says which — see [Cost](#cost).

**Usage providers** — add, edit, test and remove providers from inside the app instead of hand-writing JSON. It writes the same config file, and a key you type goes into a separate owner-only secrets file rather than into the config. See [Editing providers from the app](#editing-providers-from-the-app).

## Install

Plugin code is trusted and unsandboxed. The server half runs in a subprocess with full access to the daemon machine — its files, processes, credentials, and network. Read a plugin before you install it.

```bash
cd <path-to-plugin>/usage-monitor
npm install
npm run typecheck
paseo plugin install <path-to-plugin>/usage-monitor
paseo plugin reload usage-monitor
```

The plugin system is off unless `pluginsEnabled` is `true` in the daemon config (`${PASEO_HOME:-~/.paseo}/config.json`):

```json
{
  "pluginsEnabled": true
}
```

Run `paseo reload` after changing that field. Enabling starts every configured, enabled plugin. Disabling tears them all down without restarting the daemon.

`paseo plugin reload usage-limits` picks up edits to the plugin's own TypeScript. It does **not** reload `usage-limits.json` — provider config is read per request, so a config edit takes effect on the next refresh.

## Configuration

Provider config lives in its own file, **not** in the daemon config:

```
${PASEO_HOME:-~/.paseo}/usage-limits.json
```

Two reasons it lives there rather than somewhere more obvious:

1. **The daemon's `plugins.<id>` entry cannot hold it.** That entry is a strict schema — exactly `source`, `path`, and `enabled` — and rejects any extra key. There is no `plugins.<id>.config` bag to put provider definitions in.
2. **A plugin-local config file is not reachable.** The daemon compiles the plugin's entry point and forks a worker with no arguments, no `cwd` override, and no environment variable naming the install directory. The subprocess genuinely cannot find out where it was installed from, so a file sitting next to `index.ts` could not be read at runtime.

The snapshot returned to the UI carries the resolved `configPath`, so the surface can always tell you which file it read.

You do not have to write that file by hand. The **Usage providers** surface adds, edits, tests and removes providers from inside the app, writing the same file — see [Editing providers from the app](#editing-providers-from-the-app). The rest of this section documents the format, which is worth reading either way, because the surface is a front end to it rather than a separate system.

### Top level

The file's root **is** the provider map — provider id to entry. There is no wrapper key.

```json
{
  "claude": { "preset": "claude" },
  "my-gateway": {
    "label": "My gateway",
    "source": { "kind": "http", "url": "https://gateway.example.invalid/v1/key" },
    "readings": [
      {
        "kind": "balance",
        "id": "balance",
        "label": "Balance",
        "unit": "usd",
        "remainingPath": "data.remaining"
      }
    ]
  }
}
```

A provider id must match `^[a-z][a-z0-9-]*$`: lowercase letter first, then lowercase letters, digits, or hyphens. The id is the cache key.

Every entry must supply either `preset`, or both `label` and `readings`. A missing one is a config error naming the id.

Malformed JSON, or JSON that fails the schema, makes the plugin throw a `UsageConfigError` naming the file path and the Zod message. It does not fall back to defaults — a typo you cannot see would be worse than a loud failure. An absent file _does_ fall back to defaults (see [Defaults](#defaults)).

### Provider entry

| Field               | Type                      | Required                  | Default  | Notes                                                                                   |
| ------------------- | ------------------------- | ------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `preset`            | string                    | no                        | —        | Names a built-in preset to start from. Without it, `label` and `readings` are required. |
| `label`             | string                    | required without `preset` | —        | Card title.                                                                             |
| `description`       | string                    | no                        | —        | Subtitle.                                                                               |
| `enabled`           | boolean                   | no                        | `true`   | `false` keeps the entry in the file but stops it being read.                            |
| `refreshIntervalMs` | integer, 30000 – 86400000 | no                        | `300000` | Cache TTL for this provider.                                                            |
| `credentials`       | credential map            | no                        | `{}`     | See [Credentials](#credentials).                                                        |
| `source`            | source object             | no                        | —        | Omit only when every reading is schedule-driven and needs no request.                   |
| `readings`          | array of readings, min 1  | required without `preset` | —        | See [Readings](#readings).                                                              |

`unverified` is not settable from config. It is a property of a preset, marking one whose endpoint no vendor has published.

### Preset merge rules

An entry with `preset` starts from that preset, then each field present on the entry replaces the preset's field. The replacement is wholesale, with one exception:

| Field                                                  | Merge                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `label`, `description`, `enabled`, `refreshIntervalMs` | Replaced.                                                               |
| `source`                                               | Replaced as a whole object. You cannot override just the `url`.         |
| `readings`                                             | Replaced as a whole array. There is no per-reading merge.               |
| `credentials`                                          | Merged **by credential name**; the entry wins per name, others survive. |

Every shipped preset declares exactly one credential name, so repointing a preset's key means re-declaring that one name:

```json
{
  "deepseek": {
    "preset": "deepseek",
    "credentials": { "apiKey": [{ "kind": "env", "variable": "MY_OWN_KEY" }] }
  }
}
```

An entry naming a preset that does not exist becomes an error row reading `Unknown preset "<id>"`, labelled with the config key. An entry that fails validation becomes an error row carrying the joined Zod issues. Neither vanishes from the snapshot.

### Readings

`readings` is a list discriminated on `kind`. Shared fields:

| Field   | Type   | Required | Notes                                                                                                                                               |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | string | yes      | Stable within the provider. With `each`, this is the prefix and `idPath` supplies the per-element part.                                             |
| `label` | string | yes      | Bar label.                                                                                                                                          |
| `group` | string | no       | Groups readings inside one card. A vendor that meters Google and non-Google models separately gets one group per family, each with its own windows. |

#### `kind: "quota"`

| Field                  | Type      | Required | Notes                                                                 |
| ---------------------- | --------- | -------- | --------------------------------------------------------------------- |
| `unit`                 | unit      | yes      | One of `tokens`, `requests`, `credits`, `flows`, `usd`, `percent`.    |
| `window`               | window    | no       | The resetting bucket this quota belongs to.                           |
| `each`                 | each      | no       | Project one reading per array element.                                |
| `scale`                | number    | no       | Multiplies every amount. See [Scaling an amount](#scaling-an-amount). |
| `usedPath`             | JSON path | no       | Amount consumed.                                                      |
| `limitPath`            | JSON path | no       | Ceiling.                                                              |
| `remainingPath`        | JSON path | no       | Amount left.                                                          |
| `percentPath`          | JSON path | no       | 0–100 consumed, straight from the response.                           |
| `percentRemainingPath` | JSON path | no       | Use when the response reports what is _left_ as a percentage.         |

Give a quota enough to place itself on a scale: `usedPath` with one of `limitPath` / `remainingPath`, or `percentPath` alone, or `percentRemainingPath` alone. The resolved reading carries `used`, `limit`, `remaining`, and `percent` (0–100 consumed, derived from whichever pair resolved). Any of them can be null.

#### `window`

| Field             | Type      | Required | Notes                                                                                |
| ----------------- | --------- | -------- | ------------------------------------------------------------------------------------ |
| `label`           | string    | yes      | Names the bucket: `"Session"`, `"Weekly"`.                                           |
| `resetsAtPath`    | JSON path | no       | ISO timestamp, epoch seconds, or epoch milliseconds; all normalise to an ISO string. |
| `resetsInSecPath` | JSON path | no       | Seconds from the injected reading time; used when `resetsAtPath` does not resolve.   |
| `durationMs`      | integer   | no       | How long the window lasts, as a literal.                                             |
| `durationMsPath`  | JSON path | no       | Same, read from the response.                                                        |

With both a reset time and a duration, the bar can show how much of the window has elapsed, marking where even consumption would put you.

Supply a duration only when you actually know it. Several presets deliberately omit it — the `kimi` window and the `minimax` interval windows carry a reset time but no `durationMs`, because those window lengths are unpublished. Those bars show when the window resets and no pace marker, which is the honest rendering of what the vendor tells us.

#### `kind: "balance"`

| Field                  | Type      | Required | Notes                                                                 |
| ---------------------- | --------- | -------- | --------------------------------------------------------------------- |
| `unit`                 | unit      | yes      | Usually `usd` or `credits`.                                           |
| `each`                 | each      | no       | Project one reading per array element.                                |
| `scale`                | number    | no       | Multiplies every amount. See [Scaling an amount](#scaling-an-amount). |
| `remainingPath`        | JSON path | no       | What is left.                                                         |
| `totalPath`            | JSON path | no       | Starting balance, so a percentage is meaningful.                      |
| `percentRemainingPath` | JSON path | no       | 0–100 of the starting balance still available.                        |
| `currencyPath`         | JSON path | no       | Currency code for display.                                            |

A bare `remainingPath` — a prepaid balance with no ceiling — renders as a number with no bar, because there is nothing to be a fraction of.

#### Scaling an amount

`scale` multiplies every **amount** a reading resolves — `used`, `limit`, `remaining`, `total`. It never touches a percentage, because a percentage is already normalised and scaling one would be meaningless. Any non-zero number is accepted; zero is rejected, since it would erase the reading.

It exists because two real vendors report amounts in units nobody wants to read:

| Preset      | `scale`  | Why                                                                                                                           |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `novita`    | `0.0001` | It reports credit in ten-thousandths of a dollar, so `12500` means $1.25.                                                     |
| `deepinfra` | `-1`     | Its docs state verbatim that a **negative** `stripe_balance` means funds ready to spend, and a positive one means money owed. |

`deepinfra` is the interesting case: without `scale` the bar would show a debt where you have credit, and the sign convention is documented rather than inferred. Flipping it in config keeps the fix next to the mapping it corrects, instead of hiding a vendor quirk in code.

#### `kind: "rate"`

One required field, `resolution`, discriminated on `via`.

**`via: "response"`** — the document says which band is active:

| Field            | Type      | Required | Notes                       |
| ---------------- | --------- | -------- | --------------------------- |
| `statePath`      | JSON path | yes      | Band name.                  |
| `multiplierPath` | JSON path | no       | Price multiplier.           |
| `changesAtPath`  | JSON path | no       | When the band next changes. |
| `detailPath`     | JSON path | no       | Free-text detail line.      |

**`via: "schedule"`** — the band is worked out from a wall clock, and **no request is made**:

| Field               | Type            | Required | Default      | Notes                                    |
| ------------------- | --------------- | -------- | ------------ | ---------------------------------------- |
| `timeZone`          | IANA zone       | no       | `"UTC"`      | The zone `start`/`end` are expressed in. |
| `windows`           | array, min 1    | yes      | —            | Bands.                                   |
| `defaultLabel`      | string          | no       | `"Standard"` | Applies when no window is active.        |
| `defaultMultiplier` | positive number | no       | `1`          | Applies when no window is active.        |

Each entry in `windows`:

| Field        | Type            | Required | Notes                                                                |
| ------------ | --------------- | -------- | -------------------------------------------------------------------- |
| `label`      | string          | yes      | Band name.                                                           |
| `start`      | `HH:MM`         | yes      | 24-hour wall clock.                                                  |
| `end`        | `HH:MM`         | yes      | May be earlier than `start`, meaning the band wraps midnight.        |
| `days`       | array of 0–6    | no       | Weekdays the band applies on, `0` = Sunday. Omitted means every day. |
| `multiplier` | positive number | no       | Price multiplier while active.                                       |
| `detail`     | string          | no       | Free-text detail line.                                               |

Days are evaluated in the schedule's own `timeZone`, not the daemon's, so a band written in UTC does not drift when the machine moves.

`days` exists because peak pricing is usually a working-week concept. DeepSeek's peak hours are weekdays only, so without it a schedule would report peak pricing all weekend — see [A schedule-only rate provider](#a-schedule-only-rate-provider).

#### `each`

Projects one reading per element of an array, for vendors that report a variable number of buckets — one per model, one per limit. Every other path in the mapping becomes **relative to the element**.

| Field       | Type      | Required | Notes                                         |
| ----------- | --------- | -------- | --------------------------------------------- |
| `path`      | JSON path | yes      | Path to the array, from the document root.    |
| `idPath`    | JSON path | no       | Per-element id part, relative to the element. |
| `labelPath` | JSON path | no       | Per-element label.                            |
| `groupPath` | JSON path | no       | Per-element group.                            |

### Source

`source` is discriminated on `kind`.

#### `kind: "http"`

| Field     | Type                | Required | Default | Notes                                                              |
| --------- | ------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `url`     | string              | yes      | —       | `${NAME}` expands from the credential chain.                       |
| `method`  | `"GET"` \| `"POST"` | no       | `"GET"` |                                                                    |
| `headers` | string→string map   | no       | `{}`    | `${NAME}` expands in each value.                                   |
| `body`    | any JSON            | no       | —       | Sent as-is. Only meaningful for `POST`. String leaves interpolate. |
| `failure` | failure object      | no       | —       | Where a 200 response says no. See below.                           |

##### `failure`

Some vendors answer HTTP 200 with an error envelope. Z.ai's quota route says `{"code":500,"success":false,"msg":"当前用户不存在coding plan"}` to a key with no Coding Plan, and a document like that projects to nothing — an empty card, indistinguishable from a plan with nothing used. Declaring where the envelope says no turns it into an error row that quotes the vendor:

| Field         | Type                        | Required | Notes                                                                    |
| ------------- | --------------------------- | -------- | ------------------------------------------------------------------------ |
| `path`        | JSON path                   | yes      | Compared against `equals`. A path that does not resolve never matches.   |
| `equals`      | string \| number \| boolean | yes      | Strict for a string or boolean; a number also matches a numeric string.  |
| `messagePath` | JSON path                   | no       | The vendor's own wording, quoted in the error when present.              |
| `hint`        | string                      | no       | What it means and what to do, in your words. Follows the quoted message. |

```json
"failure": { "path": "success", "equals": false, "messagePath": "msg", "hint": "This key has no Coding Plan." }
```

The row reads `The provider reported an error: 当前用户不存在coding plan. This key has no Coding Plan.` A stored reading stays on screen under that notice, exactly as it does for a rejected credential. The transport worked and the key was accepted, so neither of those remedies is offered.

#### `kind: "command"`

| Field     | Type            | Required | Notes                                                                       |
| --------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `command` | string[], min 1 | yes      | argv, not a shell line. The command must print one JSON document on stdout. |
| `cwd`     | string          | no       | Working directory. Defaults to the daemon's.                                |

`${NAME}` expands in every argv entry and in `cwd`.

#### `kind: "file"`

| Field   | Type            | Required | Notes                                                              |
| ------- | --------------- | -------- | ------------------------------------------------------------------ |
| `files` | string[], min 1 | yes      | Candidate paths. The first one that holds a JSON document is read. |

```json
{
  "kind": "file",
  "files": ["${CLAUDE_CONFIG_DIR}/paseo-rate-limits.json", "~/.claude/paseo-rate-limits.json"]
}
```

A document some local process already wrote. No request, no credential, and nothing that can expire — the numbers are as fresh as the tool that produced them.

`${NAME}` here is an **environment variable on the daemon's machine**, not a credential. A path is not a secret, and the two lookups are not the same: writing a credential into a filename would both leak it and resolve from the wrong place. A leading `~` expands to the home directory, exactly as in a `jsonFile` credential.

`files` is a chain because the same document lives at a different path depending on whether the vendor's config directory is overridden. A candidate naming an unset variable is **skipped, not fatal**, so an override this machine does not use costs nothing — not even a read. When no candidate answers, the error names every one of them and why, because the two reasons want opposite fixes:

```
No usage file was readable:
  ${CLAUDE_CONFIG_DIR}/paseo-rate-limits.json (CLAUDE_CONFIG_DIR is not set),
  /home/you/.claude/paseo-rate-limits.json (no such file)
```

The first line means the override is not in use here. The second means whatever writes the file has not run. See [Reading Claude quota without a token](#reading-claude-quota-without-a-token).

#### `kind: "probe"`

| Field   | Type            | Required | Notes                              |
| ------- | --------------- | -------- | ---------------------------------- |
| `probe` | `"antigravity"` | yes      | Names a mechanism shipped as code. |

```json
{ "kind": "probe", "probe": "antigravity" }
```

The escape hatch for a vendor whose numbers no url can express. Where `http` and `command` describe _how_ to fetch, a probe just names a mechanism the plugin implements internally — because the real answer involves reading a stored credential, refreshing a token, and calling an endpoint that is not documented anywhere. That cannot be spelled as a url, so it is code, and the config only names it.

The set of probes is closed: only the values in the table above are accepted, so a probe cannot be pointed at anything new from config.

**Naming a probe is how a provider opts into a mechanism its vendor never documented, so every probe-backed preset stays flagged `unverified`** — not because it does not work, but because nothing about it is promised. See [Antigravity](#antigravity).

#### Timeouts and limits

`http` and `command` sources are bounded, so one unresponsive vendor cannot hang the whole card:

| Limit                  | Value      | Applies to           |
| ---------------------- | ---------- | -------------------- |
| Request timeout        | 15 seconds | `http` and `command` |
| Command stdout ceiling | 4 MiB      | `command` only       |

A `probe` carries its own timeouts, because it makes several calls rather than one. A `file` source needs none: a local read either answers or does not.

An HTTP source aborts the fetch after 15 seconds. A `command` source is killed after the same 15 seconds. Neither is configurable: `refreshIntervalMs` controls how _often_ a source is read, not how long a single attempt may take.

Errors from a source are deliberately vague about the request. An HTTP failure names **only the method and host** — `GET request to api.example.invalid failed` — and never the url, the headers, or the request body, because every one of those may hold an interpolated credential. A command failure names **only the binary** — `Command "acme" timed out after 15000ms` — and never the rest of the argv, for the same reason. A url with an unparseable host degrades to `the configured endpoint` rather than printing the string. A `file` source is the one exception: it names every path in full, because a path is not a secret and the path is the whole diagnosis.

The **response** body is not quoted either. A vendor that echoes a rejected token back in its error body would otherwise carry that token into the snapshot and onto the screen, so a failing status is reported as the status alone. Use `curl` against the endpoint when you need to see what it actually said.

As a second layer, a resolved credential value is redacted out of any error message before it reaches the snapshot, so a message that quotes a secret through some path not anticipated here still cannot display one.

### JSON paths

Dot and bracket paths into the parsed document:

```
data.usage
balance_infos[0].total_balance
limits[2].resets_at
["github.com"].oauth_token
```

- A key that itself contains a dot goes in quoted brackets, `["github.com"]` or `['github.com']`. A bare `github.com.oauth_token` reads `github` then `com` and finds neither. Credential files keyed by hostname, such as the Copilot extensions' `hosts.json`, need this form.
- A path that does not exist yields null. It is not an error — a vendor omitting a field is normal.
- Numeric strings coerce, so `"110.00"` and `110.0` both read as numbers.
- Timestamps accept an ISO string, epoch seconds, or epoch milliseconds. A bare number under 1e11 is read as seconds, at or above as milliseconds.
- A `resetsInSecPath` is a non-negative numeric offset from the reading's injected clock; a missing, negative or unparseable value yields null. When both reset paths resolve, `resetsAtPath` wins because an absolute timestamp does not age while the request is in flight.

## Credentials

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

### Expiry

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

#### Why it exists

Claude Code stores its OAuth token in `~/.claude/.credentials.json` at `claudeAiOauth.accessToken`, with `claudeAiOauth.expiresAt` beside it, and it refreshes that pair **only when Claude Code itself runs**. A plugin that only reads the file therefore watches it go stale, and cannot tell from the token alone that it has.

Measured on this machine: the token sat **34 hours past its expiry**. Every refresh spent a request that could only 401 — against `GET https://api.anthropic.com/api/oauth/usage`, the same endpoint that had already answered 429 with `retry-after: 1495` (see [Rate limits](#rate-limits)). So the cost of not checking is not one wasted request. It is burning a throttled budget on a request whose answer is known in advance, and reading the expiry costs nothing.

**This plugin never refreshes anyone's token.** The agent CLIs own refresh. Minting a new token from a stored refresh token would risk invalidating the CLI's own session, which is a worse failure than a stale card and not this plugin's session to spend. It reads these files and writes to none of them.

#### Which presets declare it

| Preset    | `expiresAtPath`                  | On                                                    |
| --------- | -------------------------------- | ----------------------------------------------------- |
| `claude`  | `claudeAiOauth.expiresAt`        | Both `.credentials.json` sources                      |
| `kimi`    | `expires_at`                     | All three `kimi-code.json` sources                    |
| `minimax` | `expires_at`, `oauth.expires_at` | `~/.mmx/credentials.json`, `~/.mmx/config.json` oauth |
| `codex`   | None, deliberately               | —                                                     |

`codex` is the interesting absence. `~/.codex/auth.json` carries `last_refresh`, which records when the token was last refreshed rather than when it dies, so no path in that file can honestly answer the question. A guessed expiry would skip a credential that works, so all three `codex` sources stay two-field. The `~/.mmx/config.json` `api_key` source declares none for the same class of reason: a plain API key has no expiry to read. The `github-copilot` probe reads its own credential file and is in the same position: `hosts.json` records the OAuth token and the login it belongs to, and nothing about when it dies.

#### What you see

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

### Reading Claude quota without a token

`preset: "claude"` reads the OAuth usage endpoint, so it inherits an access token's lifetime: Claude Code refreshes that token whenever it runs, and the card goes stale only if you do not run it for longer than the token lives. There is a second route with no token at all.

Claude Code passes its own `rate_limits` to a **statusline command** on every turn. A command that writes that object to disk turns the quota into a local document, which `preset: "claude-statusline"` reads through a [`file` source](#kind-file):

```json
{ "claude": { "preset": "claude-statusline" } }
```

What this buys, over the endpoint preset:

- **No credential.** Nothing to expire, nothing to reject with a 401, and no re-login when a refresh token dies.
- **No request.** The endpoint answers 429 to a second caller — Paseo's own built-in fetcher is one — and this shares nothing with it.
- **Fresher.** The numbers land at the end of every turn, rather than on a thirty-minute poll.

What it costs: **two readings instead of three.** The CLI sends no per-model limits to a statusline, so the `scoped` per-model bucket the endpoint preset reports has no equivalent here. The numbers also only move while Claude Code runs — which is when your quota moves anyway.

Install `statusline-hook.sh`, shipped beside this README, then register it:

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

Until the hook is registered the card says so, naming both paths it looked in. That is the [`file` source](#kind-file) error, verbatim.

#### Why the plugin will not refresh the token itself

The obvious shortcut — mint a new access token from the refresh token already on disk — is the one thing this plugin must never do. Claude Code's own binary settles it:

- It refreshes against `https://platform.claude.com/v1/oauth/token` and persists `refresh_token` **from the response**, defaulting to the old one only when the response omits it. The server may hand back a new one.
- That write is a compare-and-swap: it only replaces the stored credential while the on-disk refresh token still equals the one it started from, retries three times, and reports `tengu_oauth_token_refresh_lock_compromised_post_post` when it does not. You do not build a CAS against a value that never changes.
- A refresh rejected with `invalid_grant` — the canonical answer for a refresh token that has already been consumed — hits a dedicated path that clears `accessToken`, `refreshToken` and `expiresAt` on disk and forces a re-login.

So a third-party refresh consumes the token Claude Code still has cached, and the _next_ `claude` run, minutes or days later, gets `invalid_grant` and signs the user out. The blast radius lands on the user's own CLI session, not on this plugin. The plugin stays strictly read-only, and the statusline route above is why it does not need to be anything else.

## Editing providers from the app

The **Usage providers** sidebar surface adds, edits, tests and removes providers without opening an editor. It is a front end to the file documented above, not a parallel system: it writes the same `${PASEO_HOME:-~/.paseo}/usage-limits.json`, in the same shape, and a config you wrote by hand shows up in it unchanged.

### Card appearance

Four things about how a provider draws live in the same editor as the provider itself, because they are properties of that provider rather than of the session you happen to be in. They persist to `display` in `usage-limits.json` and survive a reload.

| Setting           | Choices                          | Stored as                                    |
| ----------------- | -------------------------------- | -------------------------------------------- |
| Icon & brand mark | Default, Lucide, Monogram, Image | `display.icon`, absent for the built-in mark |
| Meter             | Bar, Ring                        | `display.style`, absent for Bar              |
| Quota reads       | Used, Left                       | `display.value`, absent for Used             |
| Readings per row  | not settable - measured          | nothing                                      |

A default is stored as **absence**, not as a value: choosing Bar removes `display.style` rather than writing `"bar"`, because both renderers already read a missing key as the default. A config that stores every default would be longer without saying anything more.

**Readings per row is not a preference.** The card measures itself and divides its own inner width by the narrowest a reading may become before it stops being readable, capped between one and four columns. Resizing a card therefore reflows it immediately, and a wider card shows more per row without anyone setting a number. The consequence worth knowing: two cards of different widths show different column counts, which is the point - the count describes the card, not the provider.

A `columns` key written by an older version of this plugin parses and is dropped on the next write. Nothing reads it.

### Where a typed key goes

A key you type into the UI is **never written into `usage-limits.json`**. It goes into a sibling file:

```
${PASEO_HOME:-~/.paseo}/usage-limits.secrets.json
```

created with owner-only permissions (mode `0600`). The provider entry in the main config then references it as an ordinary `jsonFile` credential — exactly the mechanism a hand-written config uses. Nothing about the result is special-cased, which means you can read the config afterwards and understand it, and you can hand-edit a provider the surface created.

The main config therefore stays safe to read aloud, paste into an issue, or commit. The secrets file is the one file to keep to yourself.

When a preset already declares an environment-variable source, the surface keeps that source **first** in the chain and appends the stored-secret source after it. An env var you have exported still wins, so adding a key through the UI does not silently override the way you were already authenticating.

### Stored secrets are write-only

A stored secret is never sent back to the UI. The form shows it as `stored` with a replace action, so the value cannot be read back out through the surface it was typed into. Three behaviours cover everything:

| You submit        | Result                        |
| ----------------- | ----------------------------- |
| The field omitted | Existing secret is preserved. |
| A non-empty value | Existing secret is replaced.  |
| An empty value    | Stored secret is deleted.     |

### Test before you trust

Each provider has a **Test** action. It builds a one-provider service and reads it once, bypassing the cache, reporting whether it succeeded, a message, and **how many readings came back**. On success the message also names the reading ids it resolved, so you can see which of your mappings actually produced something.

That reading count is the part worth watching: a provider can succeed and still return nothing useful, which is what wrong JSON paths look like. A test that reports `ok` with zero readings means the request worked and the paths do not match.

### RPCs

The surface talks to four handlers, should you want to find them in the code or call them yourself:

| RPC                            | Does                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `usage.config.read`            | Returns the config, the two paths, preset summaries, and which credential names have a stored secret. |
| `usage.config.write-provider`  | Writes one provider entry plus any secret values, and returns the new state.                          |
| `usage.config.remove-provider` | Removes one provider by id and returns the new state.                                                 |
| `usage.config.test-provider`   | Reads one provider once and returns `ok`, a message, and a reading count.                             |

Every write returns the whole new state rather than an acknowledgement, so the surface can never drift from the file.

## Defaults

With no `usage-limits.json` at all, the plugin reads the two local agent CLIs:

```json
{
  "claude": { "preset": "claude" },
  "codex": { "preset": "codex" }
}
```

Both authenticate from files the CLIs already wrote, so this works with no setup on a machine where you have logged into Claude Code or Codex.

To opt out, create the file. Defaults apply only when it is absent, so any file you write replaces them wholesale — a file listing only `my-gateway` yields only `my-gateway`. To keep an entry in the file but silenced, set `"enabled": false`.

## Presets

Start here, because the shape of the answer is not obvious: **an ordinary API key that can read its own balance is the exception, not the norm.** DeepSeek can. Most frontier labs cannot — they gate usage behind a separate admin or organisation credential, or expose it only in per-request response headers that a poller can never see. So before looking for your provider in the table, know which of five cases you are in:

| Kind                        | What you get                                                    | Needs                                       |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| **Subscription/plan quota** | Consumption inside a resetting window, as a percentage or count | The CLI's own login, or a plan-specific key |
| **API-key balance**         | Money or credits left                                           | An ordinary API key                         |
| **Aggregator**              | Spend against a cap, per key or per account                     | An ordinary API key                         |
| **Pricing band**            | Which rate is in force now                                      | Nothing                                     |
| **Template**                | Nothing yet — a shape to repoint                                | An endpoint that does not exist yet         |

If your provider is not in the table below, read [What is not supported, and why](#what-is-not-supported-and-why) before assuming it was overlooked. The absence is usually the vendor's, not this plugin's.

### The 32 presets

| Preset                | Kind         | Reads                                                         | Endpoint                                                                     | Credential         | Sources, tried in order                                                                                              |
| --------------------- | ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `claude`              | Subscription | Session, weekly and per-model limits                          | `GET https://api.anthropic.com/api/oauth/usage`                              | `token`            | `claudeAiOauth.accessToken` in `${CLAUDE_CONFIG_DIR}/.credentials.json`, then `~/.claude/.credentials.json`          |
| `claude-statusline`   | Subscription | Session and weekly limits                                     | None — reads `~/.claude/paseo-rate-limits.json`                              | —                  | Its own statusline hook writes the file; nothing is authenticated                                                    |
| `codex`               | Subscription | Session, weekly, code-review, reserve, banked resets, credits | `GET https://chatgpt.com/backend-api/wham/usage`                             | `token`            | `tokens.access_token` in `${CODEX_HOME}/auth.json`, then `~/.codex/auth.json`, then `~/.config/codex/auth.json`      |
| `github-copilot`      | Subscription | Metered request buckets for the month                         | Probe (`probe: "github-copilot"`)                                            | —                  | `COPILOT_GITHUB_TOKEN`, then the Copilot extensions' own token in `~/.config/github-copilot/hosts.json`, `apps.json` |
| `kimi`                | Subscription | Coding request allowance for the window                       | `GET https://api.kimi.com/coding/v1/usages`                                  | `token`            | `KIMI_TOKEN`, `KIMI_API_KEY`, then `${KIMI_CODE_HOME}/credentials/kimi-code.json`, `~/.kimi-code/…`, `~/.kimi/…`     |
| `minimax`             | Subscription | Per-model consumption, rolling + weekly                       | `GET https://api.minimax.io/v1/token_plan/remains`                           | `token`            | `MINIMAX_API_KEY`, then `~/.mmx/credentials.json`, then `~/.mmx/config.json`                                         |
| `minimax-cn`          | Subscription | The same, on the mainland host                                | `GET https://api.minimaxi.com/v1/token_plan/remains`                         | `token`            | `MINIMAX_CN_API_KEY`, then `MINIMAX_API_KEY`                                                                         |
| `zai-coding-plan`     | Subscription | Session, weekly and monthly MCP-call windows                  | `GET https://api.z.ai/api/monitor/usage/quota/limit`                         | `apiKey`           | `Z_AI_API_KEY`, then `ZAI_API_KEY`                                                                                   |
| `zhipuai-coding-plan` | Subscription | The same, on the mainland host                                | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`                 | `apiKey`           | `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY`, then `BIGMODEL_API_KEY`                                                          |
| `synthetic`           | Subscription | Requests used against the plan limit                          | `GET https://api.synthetic.new/v2/quotas`                                    | `apiKey`           | `SYNTHETIC_API_KEY`                                                                                                  |
| `opencode-go`         | Subscription | Rolling 5-hour, weekly and monthly usage                      | `GET https://opencode.ai/zen/go/v1/usage`                                    | `apiKey`           | `OPENCODE_API_KEY`                                                                                                   |
| `chutes`              | Subscription | Rolling requests and monthly credits                          | `GET https://api.chutes.ai/users/me/subscription_usage`                      | `apiKey`           | `CHUTES_API_KEY`                                                                                                     |
| `zenmux`              | Subscription | Rolling 5-hour and 7-day flow quotas                          | `GET https://zenmux.ai/api/v1/management/subscription/detail`                | `apiKey`           | `ZENMUX_MANAGEMENT_API_KEY`                                                                                          |
| `antigravity`         | Subscription | Per-family session and weekly quotas                          | Probe (`probe: "antigravity"`)                                               | —                  | The user's own OAuth entry in the OS keyring                                                                         |
| `deepseek`            | Balance      | Prepaid balance and granted credit                            | `GET https://api.deepseek.com/user/balance`                                  | `apiKey`           | `DEEPSEEK_API_KEY`                                                                                                   |
| `moonshot`            | Balance      | Platform balance, USD                                         | `GET https://api.moonshot.ai/v1/users/me/balance`                            | `apiKey`           | `MOONSHOT_API_KEY`                                                                                                   |
| `moonshot-cn`         | Balance      | Platform balance, domestic host                               | `GET https://api.moonshot.cn/v1/users/me/balance`                            | `apiKey`           | `MOONSHOT_API_KEY`                                                                                                   |
| `siliconflow`         | Balance      | Prepaid balance                                               | `GET https://api.siliconflow.com/v1/user/info`                               | `apiKey`           | `SILICONFLOW_API_KEY`                                                                                                |
| `siliconflow-cn`      | Balance      | Prepaid balance, domestic host                                | `GET https://api.siliconflow.cn/v1/user/info`                                | `apiKey`           | `SILICONFLOW_API_KEY`                                                                                                |
| `stepfun-ai`          | Balance      | Available balance, USD                                        | `GET https://api.stepfun.ai/v1/accounts`                                     | `apiKey`           | `STEPFUN_API_KEY`                                                                                                    |
| `stepfun`             | Balance      | Available balance, domestic host                              | `GET https://api.stepfun.com/v1/accounts`                                    | `apiKey`           | `STEPFUN_API_KEY`                                                                                                    |
| `novita`              | Balance      | Balance against the account credit limit                      | `GET https://api.novita.ai/openapi/v1/billing/balance/detail`                | `apiKey`           | `NOVITA_API_KEY`                                                                                                     |
| `deepinfra`           | Balance      | Prepaid balance                                               | `GET https://api.deepinfra.com/payment/checklist`                            | `apiKey`           | `DEEPINFRA_API_KEY`                                                                                                  |
| `venice`              | Balance      | DIEM epoch allowance and USD balance                          | `GET https://api.venice.ai/api/v1/billing/balance`                           | `apiKey`           | `VENICE_API_KEY`                                                                                                     |
| `xai`                 | Balance      | Prepaid team credit, USD                                      | `GET https://management-api.x.ai/v1/billing/teams/${teamId}/prepaid/balance` | `apiKey`, `teamId` | `XAI_MANAGEMENT_API_KEY`; `XAI_TEAM_ID`                                                                              |
| `nano-gpt`            | Balance      | USD balance and Nano balance                                  | `POST https://nano-gpt.com/api/check-balance`                                | `apiKey`           | `NANOGPT_API_KEY`                                                                                                    |
| `poe`                 | Balance      | Points left                                                   | `GET https://api.poe.com/usage/current_balance`                              | `apiKey`           | `POE_API_KEY`                                                                                                        |
| `openrouter`          | Aggregator   | Spend cap on the current key                                  | `GET https://openrouter.ai/api/v1/key`                                       | `apiKey`           | `OPENROUTER_API_KEY`                                                                                                 |
| `openrouter-credits`  | Aggregator   | Account-wide credits purchased vs used                        | `GET https://openrouter.ai/api/v1/credits`                                   | `apiKey`           | `OPENROUTER_API_KEY`                                                                                                 |
| `vercel`              | Aggregator   | Team AI Gateway credit balance, USD                           | `GET https://ai-gateway.vercel.sh/v1/credits`                                | `apiKey`           | `AI_GATEWAY_API_KEY`, then `VERCEL_AI_GATEWAY_API_KEY`                                                               |
| `deepseek-rate`       | Pricing band | Which pricing band is in force                                | None — schedule only                                                         | —                  | None                                                                                                                 |
| `opencode-zen`        | Template     | Nothing yet                                                   | `https://example.invalid/zen/v1/balance`                                     | `apiKey`           | `OPENCODE_ZEN_API_KEY` (placeholder)                                                                                 |

Every endpoint above was verified against the vendor's own documentation or a recorded working implementation, with the exceptions called out below. The balance endpoints marked corroborated were additionally cross-checked against a working implementation that has to keep them running in production — one-api / new-api for the older balance routes, CodexBar for the coding-plan and subscription routes — which is a useful second opinion.

Corroborated: `deepseek`, `moonshot`, `moonshot-cn`, `siliconflow`, `siliconflow-cn`, `stepfun`, `novita`, `deepinfra`, `openrouter-credits`, `zai-coding-plan`, `zhipuai-coding-plan`, `minimax-cn`, `opencode-go`, `chutes`, `zenmux`.

The exceptions. **`zai-coding-plan`** and **`zhipuai-coding-plan`** read the route Z.ai's own usage-query plugin calls; the vendor documents the plugin, not the route, so the shape is recorded from the vendor's script and CodexBar's fixtures. **`opencode-go`** uses the live public route and the response names recorded by CodexBar's API parser test. **`chutes`** uses the self-scoped route and response fixture in CodexBar's fetcher tests because Chutes publishes no response schema for it. **`github-copilot`** reads a route GitHub does not document at all, so it is a probe rather than an http preset — see [GitHub Copilot](#github-copilot).

A file source above may also declare `expiresAtPath`, so a token the owning CLI has stopped refreshing is skipped rather than spent. `claude`, `kimi` and `minimax` do; `codex` cannot, and the reason is worth reading — see [Expiry](#expiry).

### Per-preset caveats

The ones with a trap in them:

- **`minimax`** needs a **Token Plan subscription key**, which the vendor issues separately from an ordinary pay-as-you-go API key. It also reports _consumption inside rolling 5-hour and weekly windows_, not a balance, so it is a quota rather than a balance despite being a paid API.
- **`moonshot` vs `moonshot-cn`** are host-locked: a key from one host returns 401 on the other. Pick the one matching where your account lives. `moonshot` is also the _platform_ key, not the coding-plan key `kimi` uses. `moonshot-cn` shows its amount unitless, because the domestic account is understood to bill in CNY and no source confirms the currency the field actually carries.
- **`siliconflow` vs `siliconflow-cn`** read the international and domestic hosts, which share a response shape but not a currency. The domestic one shows its amount unitless, as `moonshot-cn` does, because that account bills in CNY.
- **`novita`** reports credit in **ten-thousandths of a dollar**, handled by `scale: 0.0001` — see [Scaling an amount](#scaling-an-amount).
- **`deepinfra`** reports a prepaid balance as a **negative number**, handled by `scale: -1`.
- **`venice`** returns both a DIEM epoch quota and a USD balance in one call. Which one actually bills depends on the account's consumption currency, so both are shown rather than guessing.
- **`openrouter` vs `openrouter-credits`** answer different questions. The first is the spend cap on _the key you are using_; an unlimited key reports no numbers at all, which is correct and not a failure. The second is _account-wide_ credits purchased against credits used. A 401 from `openrouter-credits` means the key is not provisioned for the credits endpoint, not that the credential is wrong.
- **`claude`** polls every 30 minutes because its endpoint throttles hard — see [Rate limits](#rate-limits). **`claude-statusline`** reads the same two windows from a local file every minute instead, with no credential and no request — see [Reading Claude quota without a token](#reading-claude-quota-without-a-token).
- **`xai`** needs a **Management API key** and the **team id**, not an inference key: the balance route lives on `management-api.x.ai` and is per team. The vendor reports the balance in USD cents as a liability, so a credit arrives negative; `scale: -0.01` turns `"-2500"` into $25 in hand.
- **`zai-coding-plan` vs `zhipuai-coding-plan`** are host-locked like the Moonshot pair. Both read the **GLM Coding Plan subscription**, not pay-as-you-go credit: a plain API key with credits and no plan is accepted by the route and answered with `当前用户不存在coding plan`, "this user has no coding plan", which the preset's `failure` declaration turns into an error row saying so. Neither vendor publishes a route for the pay-as-you-go balance; that number lives in the console only. The session and weekly bars are `TOKENS_LIMIT` or `CREDIT_LIMIT` entries picked out of the `limits` array by their `unit`; the MCP bar is the `TIME_LIMIT` entry. Team accounts on bigmodel.cn also need `Bigmodel-Organization` and `Bigmodel-Project` headers, which these presets do not send — override `source.headers` for a team scope.
- **`minimax-cn`** is `minimax` on the mainland host. A key is issued for one host and answers a login failure on the other.
- **`stepfun-ai` vs `stepfun`** are the platform balance on the international and domestic hosts, host-locked like the others. This is the pay-as-you-go key, not the Step Plan subscription: the Step Plan's own windows are console-only, see below. The response's `total_cash_balance` and `total_voucher_balance` are lifetime deposits and grants, not a ceiling, so they are deliberately unmapped.
- **`github-copilot`** shows only the buckets the plan meters. The `chat` and `completions` buckets report a zero entitlement with `unlimited: true` on an individual plan, so a bar for them would read as exhausted; the probe flags each bucket `metered` and the reading filters on it, so a plan that does count chat gets a chat bar. The token must be the Copilot extensions' own OAuth token; a personal access token is refused by this route.
- **`nano-gpt`** is the one preset that POSTs, because that is how the vendor's balance route is defined. The key goes in an `x-api-key` header rather than `Authorization`.
- **`poe`** meters in points, shown as `credits` with no ceiling.
- **`synthetic`** reports a request count against the plan limit and a renewal time. Reading the route does not count against the quota, per the vendor.
- **`opencode-go`** is the Go subscription, whose public endpoint reports rolling five-hour, weekly and monthly percentage windows. It is not **`opencode-zen`**, the separate pay-per-token product whose balance route remains unavailable; the deliberately unroutable Zen template must not be pointed at the Go usage endpoint.
- **`zenmux`** needs a **Management API key**, not an inference key, and reports quota in _flows_, the vendor's own unit. Its `usage_percentage` field is a 0–1 fraction rather than a percentage, so the bars are derived from the flow counts instead. Like the GLM pair it wraps refusals in a `success: false` envelope, declared as a `failure` so an account without a Builder Plan says so rather than rendering empty. The pay-as-you-go balance is a second request this preset does not make.
- **`chutes`** reads the ordinary-key, self-scoped subscription route, not the admin balance lookup. CodexBar falls back to a second `/users/me/quotas` request when the subscription payload lacks a rolling window; one preset source cannot make that fallback, so this card shows only windows present in `subscription_usage`.
- **`zenmux`** needs a **Management API key**, not a normal inference key. The subscription-detail request carries five-hour and seven-day flow quotas; PAYG balance lives at a second endpoint, and one preset cannot combine the two requests, so this preset deliberately omits it.

### Verified and unverified

Every preset except `antigravity`, `github-copilot`, `deepseek-rate`, `claude-statusline` and `xai` declares exactly one credential name — `token` or `apiKey`, per the table. That is the name to re-declare when repointing a preset's key. `claude`, `codex` and `kimi` try several locations in order, so they keep working whether or not you have set the CLI's home-directory variable. `xai` declares two names, `apiKey` and `teamId`, because its balance route is per team and the team id lives in the url; the id is not a secret, but the credential map is the only thing that interpolates into a url, so it is stored like one. The remaining four declare none: `antigravity` and `github-copilot` read their credentials themselves, and the other two need no credential at all.

`unverified` does not mean broken. It means **the vendor promises nothing**, so the numbers may stop arriving without warning. The three unverified presets are unverified for two different reasons:

- **`antigravity`** — it works, and the numbers are real. What is missing is any published API: it reads them the way described in [Antigravity](#antigravity), which is undocumented by Google and could break at any time.
- **`github-copilot`** — the same shape. GitHub documents the limits and not the route, so the probe described in [GitHub Copilot](#github-copilot) calls the endpoint the official IDE extensions call, and could break with the extensions.
- **`opencode-zen`** — it does not work yet, by design. A balance endpoint is an open, unimplemented upstream feature request, so this preset is a **shape** — the right readings for that vendor — on a deliberately unroutable `example.invalid` host. Repoint `source` once an endpoint ships. Out of the box it fetches nothing and fails loudly.

The correspondence is enforced by a test, in both directions: a probe-backed preset must be flagged `unverified`, and an HTTP preset's url contains `example.invalid` exactly when it is flagged. So no verified preset can quietly point at a placeholder, and no placeholder can quietly claim to be verified. A `file` source contacts no host at all, so there is no guessed endpoint it could hide; what makes it verified is that its field names are the local tool's own, and a second test holds it to declaring no credential.

A guessed URL presented as fact is worse than a documented gap. That is why `opencode-zen` points at `example.invalid` rather than somewhere plausible.

You do not have to read this table to see any of it. The [Usage providers](#editing-providers-from-the-app) surface lists every preset with its endpoint, a hint describing how its credential resolves, and an **Unverified** badge where it applies.

### What is not supported, and why

These are negative results, and they are the real answer to "what about provider X". In every case the gap is the vendor's.

**Admin-credential-gated.** Usage exists but an ordinary API key cannot read it:

| Provider  | Situation                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic | Org usage and cost need a separate Admin key (`sk-ant-admin…`), which is visibly a different kind of credential. See the date-windowed note below for why a key is not enough. |
| OpenAI    | Same, but its admin key is an indistinguishable `sk-…`, so pasting the wrong one simply fails with no clue why.                                                                |
| Mistral   | Admin-Panel-gated, plus an `X-RateLimit-Remaining` header.                                                                                                                     |

**Date-windowed reports, not balances.** Anthropic's `/v1/organizations/cost_report`, OpenAI's `/v1/organization/costs` and Fireworks' `/v1/accounts/{id}/billingUsage` all exist and all answer an admin-class key, but each takes a start time as a query parameter and returns one bucket per day since. A source here is a fixed url, so it cannot say "today" and cannot pick the last bucket out of a growing page. A `command` source that computes the window and prints the current bucket can read them; a preset cannot.

**Headers-only.** The numbers exist per response and cannot be polled: Anthropic's `anthropic-ratelimit-*`, OpenAI's `x-ratelimit-*`, Groq, Mistral and Together. The reason is structural rather than a missing feature — **this plugin cannot read a header it never sends a completion to get.** Polling a quota endpoint is cheap; burning a real inference request to read a header is not, and doing it on a timer would itself consume the quota you were trying to measure. Claude Code gets these numbers precisely because it is _already_ making the calls.

**Nothing key-scoped at all.** Google Gemini exposes no per-key usage: quota lives behind Cloud Quotas with GCP IAM, which is a different product with a different credential model. Cloudflare Workers AI and AI Gateway report through the account's GraphQL analytics, not a balance. Nvidia retired its build.nvidia.com credit system for dynamic rate limits.

**Console-only.** Z.ai and Zhipu pay-as-you-go credit (the Coding Plan quota is readable, the credit balance is not: the whole `docs.z.ai` API reference covers models, tools and agents and nothing about an account), Cohere, Together, Cerebras, Perplexity, Nebius, Hugging Face inference credits, Ollama Cloud, Requesty, Modal, Weights & Biases, Crusoe and Inference.net show usage in a web console with no documented API behind it. Nebius has open feature requests asking for exactly this endpoint, so it may become possible later. Kilo is not endpoint-free: CodexBar calls `https://app.kilo.ai/api/trpc` with `KILO_API_KEY`, but a preset still needs the tRPC procedure name and payload, which have not been established here. OpenCode Zen's balance is the open request the `opencode-zen` template waits on; OpenCode Go subscription windows are supported by `opencode-go`.

**Cloud-account billing.** DigitalOcean and Vultr document account balance routes, but they report the whole cloud account as money owed, not inference credit, and their sign conventions differ. They are readable as hand-written providers if you want them on the board.

**Browser session only.** Several of the large Chinese labs meter their coding and token plans behind the web console, with no API-key route at all. The numbers exist, but reading them means replaying a logged-in browser session — cookies plus a console CSRF token — which is a different kind of credential from anything this plugin stores, and one that expires with the tab. CodexBar does exactly that, so its provider notes are the reference for what each console returns:

| Provider                                     | Situation                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba Coding Plan (Model Studio / Bailian) | A console RPC (`/data/api.json?action=…queryCodingPlanInstanceInfoV2`) that answers `ConsoleNeedLogin` to an API key on many accounts. When it does answer a key, it carries 5-hour, weekly and monthly used/total pairs.                                                           |
| Alibaba Token Plan, Qwen Cloud               | Console cookies or a signed-in `bl` CLI. `bl usage token-plan --output json` is a workable `command` source if you have the CLI.                                                                                                                                                    |
| Volcengine Ark / Doubao coding plan          | The `arkcli usage plan --format json` CLI after `arkcli auth login`; the API key itself only reveals `x-ratelimit-*` headers on a completion. A `command` source over `arkcli` works.                                                                                               |
| StepFun Step Plan                            | A username-and-password login flow yielding an `Oasis-Token` cookie whose access half expires in about thirty minutes. The rate-limit route then reports remaining _fractions_ (`0.9978`), which no percent path can rescale. The pay-as-you-go balance is readable, see `stepfun`. |
| Tencent TokenHub, Token Plan, Coding Plan    | Balance and plan quota exist only behind Tencent Cloud's signed (AK/SK) API or the console; nothing answers a bearer key.                                                                                                                                                           |
| Xiaomi MiMo, Meituan LongCat                 | Console cookies (`api-platform_serviceToken` and `userId` for MiMo; a `longcat.chat` session for LongCat).                                                                                                                                                                          |

A `command` source that wraps the vendor's CLI is the honest route for the CLI-backed ones; see [A local command that prints JSON](#a-local-command-that-prints-json).

**Dead.** OpenAI's legacy `/v1/dashboard/billing/*` pair no longer works for API keys, despite still being present in one-api. It is not coming back.

**Out of scope.** AIProxy and API2GPT are resellers rather than first-party providers.

If a vendor ships an endpoint, none of this needs a code change — write a provider entry, or add one through the Usage providers surface.

### Antigravity

This one works. Live output on this machine:

| Bucket          | Window  | Group                 | Used   | Resets               |
| --------------- | ------- | --------------------- | ------ | -------------------- |
| `gemini-5h`     | Session | Gemini Models         | 9.23%  | 2026-08-28T22:11:13Z |
| `gemini-weekly` | Weekly  | Gemini Models         | 25.06% | 2026-09-01T20:00:00Z |
| `3p-5h`         | Session | Claude and GPT models | 0%     | —                    |
| `3p-weekly`     | Weekly  | Claude and GPT models | 0%     | —                    |

Two shared pools, each with a rolling 5-hour and a weekly window. That is exactly the model-family-plus-two-windows shape the `group` field and the `each` projection were designed for. All four buckets are always emitted, with null readings when the response omits one, so a missing bucket never shifts the others.

#### How it works

You should know this before enabling it, so you can judge it yourself. Google publishes no Antigravity quota API. The probe:

1. Reads your own Antigravity OAuth credential from the OS keyring — a Secret Service item over D-Bus on Linux, the equivalent Keychain generic password on macOS (service `gemini`, account `antigravity`). It never writes to that item.
2. Obtains Antigravity's OAuth client id and secret by scanning the installed `agy` binary, rather than hardcoding them, so the plugin ships no vendor secret and follows whatever your install has.
3. Refreshes the access token against `https://oauth2.googleapis.com/token`, because a stored token lasts an hour and is usually stale. The refresh returns no new refresh token, so your stored credential is left exactly as Antigravity wrote it.
4. POSTs to `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` — an undocumented Cloud Code endpoint — with that token.

The method was derived from ClaudeBar's probe. ClaudeBar's _primary_ path is different: a Connect-protocol call to a running Antigravity `language_server` over loopback, authenticated with a CSRF token scraped from the process command line. That path found nothing here, because no Antigravity IDE or language server runs on this machine, so this plugin does not implement it and uses the keyring route above instead.

#### The risks

This impersonates the Antigravity client rather than using a published API. Concretely: it may violate Google's terms of service, it can break without notice, and it touches both your OS keyring and a vendor binary on disk. Those are real costs, not theoretical ones.

So it is opt-in, it stays flagged `unverified`, and the flag is shown on the card. **If you are not comfortable with the above, do not enable it** — and if you enabled it and changed your mind, remove it with one click in the [Usage providers](#editing-providers-from-the-app) surface.

### GitHub Copilot

The second probe, and a much smaller one. GitHub documents Copilot's premium-request limits, the monthly reset and the overage rules, but publishes no route to read a seat's consumption. The official Copilot IDE extensions read it from an internal endpoint on start-up, and that is what this probe calls:

1. Finds your own Copilot OAuth token: `COPILOT_GITHUB_TOKEN` if you exported one, else the token the extensions stored in `hosts.json` or `apps.json` under `~/.config/github-copilot` (or `$XDG_CONFIG_HOME/github-copilot`), keyed by hostname. It never writes to those files and never refreshes the token; the extensions own it, and it is long-lived.
2. Sends `GET https://api.github.com/copilot_internal/user` with that token and the headers the Copilot Chat extension sends. A bare request without them is refused, and so is a personal access token, which is why the override is named for Copilot rather than GitHub.
3. Maps `quota_snapshots` onto a fixed bucket list — `premium`, `chat`, `completions` — always in that order, each flagged `metered` only when the response carries it and does not call it unlimited. The reading filters on that flag, so an individual plan shows one bar and a plan that counts chat shows two, and an unlimited bucket never renders as exhausted.

Recorded output for an individual plan, which is the shape the tests project:

| Bucket        | Metered | Entitlement | Remaining | Resets     |
| ------------- | ------- | ----------- | --------- | ---------- |
| `premium`     | yes     | 300         | 285       | 2026-10-01 |
| `chat`        | no      | 0           | 0         | 2026-10-01 |
| `completions` | no      | 0           | 0         | 2026-10-01 |

The risks are the Antigravity ones in miniature: this impersonates the Copilot client rather than using a published API, and it can break the day the extensions change their route or headers. It reads a credential file but no keyring and no vendor binary. It stays flagged `unverified`, and the flag is shown on the card.

### Rate limits

`claude` ships with `refreshIntervalMs: 1800000` — 30 minutes, not the 5-minute default. The reason is measured, not cautious.

`GET https://api.anthropic.com/api/oauth/usage` answered:

```http
HTTP/1.1 429 Too Many Requests
retry-after: 1495

{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}
```

That `retry-after` is about 25 minutes, and it is a real instruction rather than a placeholder, so the plugin honours it exactly instead of guessing.

Two things on one machine share that budget. Paseo's own built-in provider-usage fetcher calls the same endpoint to populate the Host usage view in Settings, on demand, at most once per 5 minutes. This plugin is the second caller. Thirty minutes clears the observed window for both and still resolves a 5-hour bucket well before it turns over.

**Claude Code itself does not poll this endpoint.** Its own implementation takes quota from the rate-limit _response headers_ of ordinary API calls — `five_hour` and `seven_day` utilization plus `resets_at` — persists the last value it saw, and when it is rate-limited it seeds its display from that cache and marks it seeded. The endpoint is a seed, not a polling target. This plugin behaves the same way for the same reason.

#### What a 429 does

On a 429 the provider enters a per-provider backoff and **stops asking** until it expires:

| Situation                                | Wait                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| `Retry-After` present and plausible      | Exactly that long.                                              |
| Absent, zero, backwards, or over 6 hours | 15 minutes, doubling per consecutive 429, capped at 60 minutes. |

A `Retry-After` beyond six hours says more about the vendor's clock than about when to come back, so it is ignored in favour of the plugin's own escalation. The escalation counter resets the moment a request succeeds.

While backed off, the card keeps its **last good readings with their original timestamp** — real numbers beat replacing them with an error row — and carries a `notice` such as:

```
Rate limited by the provider. Showing the reading from 14:05 and retrying at 14:30.
```

The surface renders that notice in the warning colour, marks the card stale, and turns its status dot warning, so a stale card is never mistaken for a current one.

A manual refresh during a backoff deliberately issues **no request**. Retrying immediately is exactly what re-triggers the 429 and extends the lockout, so the refresh returns the seeded snapshot instead. Wait for the retry time in the notice. The backoff is not configurable.

If a provider is rate-limited before it ever succeeded, there are no readings to seed from, so the card is a normal error row — with the same `notice` attached, so you still know when it will retry.

## Recipes

Every block below is a complete `usage-limits.json`.

### A preset with a key from the environment

```json
{
  "openrouter": {
    "preset": "openrouter",
    "refreshIntervalMs": 1800000,
    "credentials": {
      "apiKey": [{ "kind": "env", "variable": "OPENROUTER_API_KEY" }]
    }
  }
}
```

The preset already declares `apiKey`. Re-declaring it here repoints it — useful when your key lives under a different variable name. A balance endpoint moves slowly, so 30 minutes is plenty.

### A hand-written HTTP provider

No preset. Two readings from one document: a windowed token quota and a prepaid balance.

```json
{
  "acme-ai": {
    "label": "Acme AI",
    "description": "Monthly token allowance and prepaid balance",
    "refreshIntervalMs": 600000,
    "credentials": {
      "apiKey": [
        { "kind": "env", "variable": "ACME_API_KEY" },
        { "kind": "jsonFile", "file": "~/.config/acme/auth.json", "path": "tokens.access_token" }
      ]
    },
    "source": {
      "kind": "http",
      "url": "https://api.example.invalid/v1/usage",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer ${apiKey}",
        "Content-Type": "application/json"
      },
      "body": { "scope": "account" }
    },
    "readings": [
      {
        "kind": "quota",
        "id": "monthly-tokens",
        "label": "Monthly tokens",
        "unit": "tokens",
        "window": {
          "label": "Monthly",
          "resetsAtPath": "period.resets_at",
          "durationMs": 2592000000
        },
        "usedPath": "period.tokens_used",
        "limitPath": "period.tokens_limit"
      },
      {
        "kind": "balance",
        "id": "credit",
        "label": "Prepaid credit",
        "unit": "usd",
        "remainingPath": "credit.remaining",
        "totalPath": "credit.granted",
        "currencyPath": "credit.currency"
      }
    ]
  }
}
```

The URL and every path are placeholders. Substitute your vendor's own, then check them against a real response (see [Troubleshooting](#troubleshooting)).

### A local command that prints JSON

When a vendor ships a CLI that already knows how to authenticate, let it. No credentials block is needed, because the plugin holds no secret — the CLI does.

```json
{
  "acme-cli": {
    "label": "Acme (CLI)",
    "description": "Balance reported by the vendor CLI, which authenticates itself",
    "refreshIntervalMs": 900000,
    "source": {
      "kind": "command",
      "command": ["acme", "billing", "balance", "--json"],
      "cwd": "/var/lib/acme"
    },
    "readings": [
      {
        "kind": "balance",
        "id": "balance",
        "label": "Balance",
        "unit": "usd",
        "remainingPath": "balance.amount",
        "currencyPath": "balance.currency"
      }
    ]
  }
}
```

`command` is argv, not a shell line — the child is spawned with no shell, so pipes, globs, and quoting do nothing. The command must print exactly one JSON document on stdout and nothing else. Progress lines or logs on stdout break parsing; send those to stderr. A non-zero exit is reported as an error.

Two hard bounds apply. The command is killed after **15 seconds**, and its stdout is capped at **4 MiB** — exceeding the cap kills the child and reports that the command printed more than 4194304 bytes. The two are told apart properly, so an oversized dump is never misreported as a timeout. Both are well clear of a balance endpoint's output; if you are near either, the command is doing more than reporting usage.

### A schedule-only rate provider

A `rate` reading resolved `via: "schedule"` needs no document, so a provider made only of schedule-driven rates omits `source` entirely: no endpoint, no credentials, no network. This is what the `deepseek-rate` preset is, written out longhand:

```json
{
  "deepseek-pricing": {
    "label": "DeepSeek pricing",
    "description": "Which pricing band is in force right now",
    "readings": [
      {
        "kind": "rate",
        "id": "pricing",
        "label": "Pricing",
        "resolution": {
          "via": "schedule",
          "schedule": {
            "timeZone": "UTC",
            "defaultLabel": "Off-peak",
            "defaultMultiplier": 1,
            "windows": [
              {
                "label": "Peak",
                "start": "01:00",
                "end": "04:00",
                "days": [1, 2, 3, 4, 5],
                "multiplier": 2
              },
              {
                "label": "Peak",
                "start": "06:00",
                "end": "10:00",
                "days": [1, 2, 3, 4, 5],
                "multiplier": 2
              }
            ]
          }
        }
      }
    ]
  }
}
```

Three things about this shape are worth copying.

**Off-peak is the default, not a window.** Two peak windows are declared and everything else — evenings, nights, the entire weekend — falls through to `defaultLabel`. Declaring the smaller set is less to get wrong, and a schedule with no active window is still meaningful rather than blank.

**Peak is the multiplier, not off-peak.** Off-peak sits at the baseline `1` and peak is `2`, which says the same thing as "off-peak is half price" while keeping the baseline where the arithmetic is obvious.

**`days: [1, 2, 3, 4, 5]` is load-bearing.** DeepSeek's peak hours are Monday to Friday. Without `days` this schedule would report peak pricing all weekend, which is exactly backwards for the two days you are most likely to be using the discount.

> **These times are current as of DeepSeek's 24 July 2026 change.** The old 16:30–00:30 UTC off-peak window was retired then; peak is now 01:00–04:00 and 06:00–10:00 UTC on weekdays, with everything else at half the peak rate. A schedule is published information, not measured, so this file cannot notice when it changes — confirm against the vendor's pricing page before relying on it, and prefer the `deepseek-rate` preset, which is kept up to date here.

### An `each` projection over a per-model array

MiniMax reports one object per model in `model_remains`, and the number of models is not fixed. `each` projects one reading per element, with every other path relative to that element.

```json
{
  "minimax": {
    "preset": "minimax",
    "readings": [
      {
        "kind": "quota",
        "id": "interval",
        "label": "Interval",
        "unit": "requests",
        "each": { "path": "model_remains", "idPath": "model_name", "labelPath": "model_name" },
        "window": { "label": "Interval", "resetsAtPath": "end_time" },
        "usedPath": "current_interval_usage_count",
        "limitPath": "current_interval_total_count",
        "percentRemainingPath": "current_interval_remaining_percent"
      },
      {
        "kind": "quota",
        "id": "weekly",
        "label": "Weekly",
        "unit": "requests",
        "each": { "path": "model_remains", "idPath": "model_name", "labelPath": "model_name" },
        "window": { "label": "Weekly", "resetsAtPath": "weekly_end_time" },
        "usedPath": "current_weekly_usage_count",
        "limitPath": "current_weekly_total_count",
        "percentRemainingPath": "current_weekly_remaining_percent"
      }
    ]
  }
}
```

Two readings over the same array give every model both an interval bar and a weekly bar. `usedPath` and `limitPath` are relative to each element; `each.path` is the only path resolved from the document root.

See `usage-limits.example.json` for one file combining a preset, an override, a hand-written provider, a command provider, and a schedule-only rate.

## Usage history

### Where the numbers come from

Paseo persists no usage time series. Its `lastUsage` is the latest turn only, it never reaches disk, and the plugin SDK does not expose it. Sampling forward from first run would mean an empty chart for a month.

So history is read out of the agent CLIs' own transcript logs, which already contain per-message token counts going back as far as you have kept them:

| CLI         | Scanned                                                                | Root override                                                                                           |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claude Code | `<root>/projects/**/*.jsonl`                                           | `CLAUDE_CONFIG_DIR` (comma-separated), else both `${XDG_CONFIG_HOME:-~/.config}/claude` and `~/.claude` |
| Codex       | `<root>/sessions/**/*.jsonl` and `<root>/archived_sessions/**/*.jsonl` | `CODEX_HOME` (comma-separated), else `~/.codex`                                                         |

A `CLAUDE_CONFIG_DIR` entry that already ends in `projects` is normalised to its parent. For Codex, if neither `sessions` nor `archived_sessions` yields files, the reader falls back to `<root>/**/*.jsonl`.

Reading files the CLIs own means history works retroactively on first launch, and it also means the plugin only ever reads. It writes nothing to either CLI's directory.

### Buckets

| Range | Bucket  | Buckets |
| ----- | ------- | ------- |
| `24h` | 1 hour  | 25      |
| `7d`  | 6 hours | 29      |
| `30d` | 1 day   | 31      |

Bucket starts are floor-aligned to the bucket size in UTC. The count is one more than the window divides into, because both ends are partial: flooring the window start reaches back before it, and the bucket containing _now_ is still filling. A 24h query therefore returns 25 hourly buckets, of which the first and last cover only part of their hour.

Every bucket in the window is emitted, including empty ones, so the chart has no gaps that look like missing data rather than idle time.

### Scan cost

A transcript directory grows without bound, so the reader stats every candidate before it reads any. A file is skipped without being opened when its mtime is older than the start of the window, when its size is zero, or when it exceeds 64 MiB (see [Scan failures](#scan-failures)). Rows that parse but fall outside the window are dropped afterwards.

That makes a 24h query cheap regardless of how much history you have accumulated, and it is why the `30d` view costs more than the `24h` one.

### Dedup

Transcripts duplicate records — resumed sessions, forks, copied project directories — so raw sums overcount badly.

- **Claude Code** dedups on `message.id`, falling back to `requestId` only when `message.id` is absent. On a collision the larger token total wins. On a tie, a normal record beats an `isSidechain: true` one.
- **Codex** dedups on the tuple of `timestamp`, `model`, and each token count (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`).

Both dedup maps are global across the whole scan, not per file, so duplicated and copied files collapse into one contribution.

### Series, expansion and colour

Each series is one agent CLI and `seriesKey` is its id (`claude-code`, `codex`, `omp-anthropic`). Every provider row also carries `children`: one row per model that provider ran, so expanding a provider costs no second request. A provider that ran exactly one model still gets a one-element `children` array, so the row opens onto that one model rather than looking inert.

Buckets carry values at both levels. A top-level row has `parentKey: null`; a model row has `parentKey` set to its provider's key. A bucket's own totals sum **only** the `parentKey: null` rows, so summing every value double-counts the window. Children cover 100% of their parent on all seven token counters and on cost, in every bucket, so expanding a provider never changes a column's height - it only subdivides it.

Grouping by model lifts every model to the top level with empty `children`, which is the only way to compare two models you reach through different tools.

The plotted-series cap applies per level. Which providers get a band is decided from the collapsed rows alone, so expanding one provider can never evict another provider's band; inside an expanded provider its own tail folds into an indented `Other` that reconciles to that provider, not to the window.

### Colour

`PluginTheme` exposes one accent and no categorical palette, so the series palette is derived from the theme rather than hardcoded, and it changes with the theme.

Hue carries category and lightness carries nesting. Top-level colours rotate hue evenly around the accent in OKLCH, holding lightness and chroma in a band chosen from the surface colours' mean luminance; the models inside an expanded provider keep the parent's hue and separate by lightness only. Neither axis borrows the other's job, so a dim provider band can never be mistaken for a bright neighbour's model.

Colours are gamut-mapped by giving up chroma while holding lightness and hue, because clipping RGB channels shifts hue and is how an even rotation lands two series on the same colour.

Every colour clears **3:1** against `surface0`, `surface1` and `surface2` - WCAG 2.1 SC 1.4.11, the non-text rule, because a band is a graphical object carrying meaning. All three surfaces are checked, not just the one a band sits on, since a legend swatch and a bar sit on different surfaces in the same view. The text rule of 4.5:1 was rejected deliberately: it forces every band toward the ends of the lightness range and collapses the hue separation the palette exists to provide. Measured worst case across the shipped themes is 3.67:1 at fourteen series.

An unparseable accent falls back rather than throwing, and a count of zero still yields one colour, so a malformed theme degrades instead of rendering a blank chart.

### Which metric, and why work is the default

A single "tokens" number is misleading, so the surface has a metric selector. Measured on this machine's real transcripts over 30 days:

| Component                    | Tokens     | Share |
| ---------------------------- | ---------- | ----- |
| Cache reads (`cachedTokens`) | 23,584,524 | 99.5% |
| Output (`outputTokens`)      | 124,734    | 0.5%  |
| Input (`inputTokens`)        | 336        | ~0%   |

Cache reads are 99.5% of the raw total. That is not an anomaly: re-reading a cached prompt prefix is counted on **every** turn, so a long conversation re-bills its own history each time it continues. A headline "23.7M tokens" therefore says almost nothing about how much work was done, and reads as though it does.

Three metrics are available:

| Metric   | Formula                        | What it tells you                                                 |
| -------- | ------------------------------ | ----------------------------------------------------------------- |
| `work`   | `inputTokens + outputTokens`   | Tokens the turns actually consumed and produced. **The default.** |
| `cached` | `cachedTokens`                 | Cache re-reads alone — prefix size multiplied by turn count.      |
| `total`  | `tokens`, the sum of all three | The raw figure, for reconciling against a vendor's own dashboard. |

`work` is the default because it is the number that moves when you do more work, and the only one of the three that is comparable between a short session and a long one. `cached` and `total` are dominated by conversation length, so they grow while you idle inside a long thread.

Cache reads are real — they are billed, usually at a reduced rate — so they are neither hidden nor discarded. They are simply not work performed, and the default view says so. The split is shown under the headline whichever metric is selected, so the composition is never hidden behind the choice.

Every bucket, every per-series bucket value, and every series carries `inputTokens`, `outputTokens`, and `cachedTokens` alongside `tokens`, and the snapshot carries `totalInputTokens`, `totalOutputTokens`, and `totalCachedTokens` alongside `totalTokens`. The metric is a client-side choice over data already in one response: it is **not** part of `UsageHistoryQuery`, so switching metric re-renders without a refetch.

### Cost

Cost is a fourth metric beside Work, Cached and Total, and it exists because tokens are not comparable across vendors. A cheap model can run several times another's tokens for a fraction of the money, so a token chart ranks providers in an order the invoice does not.

Two sources, in order. A log that reports its own cost wins - omp session transcripts carry `message.usage.cost.total`, and Claude Code carries a top-level `costUSD` (still `null` in current transcripts). Everything else is priced from LiteLLM's public rate table, fetched once and cached for 24 hours under `usage-limits/model-rates.json`.

The surface always says which, because a number you cannot date is a number you cannot trust: `Priced from today's rate table.`, `Priced from a rate table fetched 6h ago.`, or `Cost is unavailable: no rate table could be loaded, so these tokens cannot be priced.` - in which case the metric is disabled rather than showing zeros. Models the table could not price are named in that line.

Cache reads, cache writes and output are priced separately, since a cache read costs about a tenth of fresh input. Long-TTL cache writes are priced separately again: Anthropic bills a 1-hour cache write at 1.6x the 5-minute rate, and where a transcript uses 1-hour caching throughout, pricing that category flat understates it by 37.5%. `cacheSavingsUsd` reports what the cache reads saved against paying fresh input rates.

**A null cost is not a zero cost.** A series no rate could price stays visible and reads `unpriced`; any total containing one is `null` rather than a partial sum, and a `+` suffix marks a figure that is a floor. A wrong rate is worse than no rate, so model-id resolution never crosses a modality boundary on an inexact match - a text model will go unpriced rather than borrow an image model's price.

The original objection to a dollar figure still stands and is why it works this way: a price table _bundled_ into this plugin would drift out of date silently and report confident wrong numbers. Fetching the canonical table, caching it, and showing its age is a different thing.

### Known gaps

- **OpenCode** records usage in a SQLite database rather than JSONL. That database was empty on this machine, so nothing could be verified against it, and it is not read. Its usage does not appear in history.
- **Antigravity** stores opaque `.pb` files with no token accounting in them. There is nothing to parse, so it can never appear in history regardless of future work here.

### Scan failures

Nothing in the reader throws for a missing or unreadable path. A partial scan always returns a chart plus a list of what it could not read, in `scanErrors` — each entry carrying the `source` that failed and a `message`. Every failure is attributed to the thing that actually failed, so no gap is silent.

| Situation            | Result                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Missing directory    | Empty result, no error. Not having Codex installed is not a failure.                                                   |
| Unreadable directory | One scan error naming **that** directory, with the OS message. Every sibling file the walk did reach is still counted. |
| Unreadable file      | One scan error: `source` is the file path, `message` is `Could not read transcript file`.                              |
| File over 64 MiB     | Skipped unread. One scan error: `source` is the file path, `message` is `Transcript exceeds the 64 MiB scan limit`.    |
| Malformed line       | Skipped silently. Not a scan error — a truncated last line is normal in a log being appended to.                       |

An unreadable directory is reported the same way at any depth. There is no root-versus-nested distinction: the failing directory names itself, whether it is `~/.claude/projects` or something six levels down, and the rest of the tree still scans. So a permissions problem shows up as a chart that reads low **and** an error telling you exactly which directory to fix.

Unlike the two fixed messages above, a directory error carries the raw OS text rather than a constant, because the operating system already says the useful thing. On Linux it reads:

```
EACCES: permission denied, scandir '/home/you/.claude/projects/locked-project'
```

Duplicate errors are collapsed on the `source` and `message` pair, so overlapping scan roots report a given failure once. A `CODEX_HOME` whose `sessions` subdirectory fails and is then walked again under the root fallback yields one error, not two.

The 64 MiB ceiling exists because the plugin subprocess reads synchronously and the daemon abandons an RPC after 30 seconds. One pathological transcript would otherwise time out the whole query and show nothing at all.

The size check runs _after_ the cheap skips, and that order is deliberate. A missing stat, a zero-size file, and a stale mtime all mean the file could not have contributed a row to the requested window, so reporting them would be permanent noise you cannot act on — a 200 MiB rollout from March would otherwise light up the 24h view forever. The ceiling error fires only for a file that _would_ have been read, which is the only case where you actually lose data.

## Troubleshooting

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
| `<METHOD> request to <host> failed with HTTP 429`      | Rate limited. Not a fault — see [Rate limits](#rate-limits).                                  |
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

**The Claude card says the credential expired or was rejected.** Both mean the same thing in practice: the token in `~/.claude/.credentials.json` is no longer good, and this plugin cannot mint a new one — Claude Code owns that file's refresh (see [Expiry](#expiry)).

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

**History reads low.** Check `scanErrors` first — it names every directory and file the scan could not read, so a permissions problem inside the transcript tree points at itself (see [Scan failures](#scan-failures)). If `scanErrors` is empty, the scan read everything it could find, and the shortfall is real: either the window is longer than your retained transcripts, or the CLI writes somewhere the reader is not looking.
