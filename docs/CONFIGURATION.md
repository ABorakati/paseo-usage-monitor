# Configuration

Provider config lives in its own file, **not** in the daemon config:

```
${PASEO_HOME:-~/.paseo}/usage-limits.json
```

Two reasons it lives there rather than somewhere more obvious:

1. **The daemon's `plugins.<id>` entry cannot hold it.** That entry is a strict schema — exactly `source`, `path`, and `enabled` — and rejects any extra key. There is no `plugins.<id>.config` bag to put provider definitions in.
2. **A plugin-local config file is not reachable.** The daemon compiles the plugin's entry point and forks a worker with no arguments, no `cwd` override, and no environment variable naming the install directory. The subprocess genuinely cannot find out where it was installed from, so a file sitting next to `index.ts` could not be read at runtime.

The snapshot returned to the UI carries the resolved `configPath`, so the surface can always tell you which file it read.

You do not have to write that file by hand. The **Usage providers** surface adds, edits, tests and removes providers from inside the app, writing the same file — see [Editing providers from the app](../README.md#editing-providers-from-the-app). The rest of this guide documents the format, which is worth reading either way, because the surface is a front end to it rather than a separate system.

## Top level

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

Malformed JSON, or JSON that fails the schema, makes the plugin throw a `UsageConfigError` naming the file path and the Zod message. It does not fall back to defaults — a typo you cannot see would be worse than a loud failure. An absent file _does_ fall back to defaults (see [Defaults](../README.md#defaults)).

## Provider entry

| Field               | Type                      | Required                  | Default  | Notes                                                                                   |
| ------------------- | ------------------------- | ------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `preset`            | string                    | no                        | —        | Names a built-in preset to start from. Without it, `label` and `readings` are required. |
| `label`             | string                    | required without `preset` | —        | Card title.                                                                             |
| `description`       | string                    | no                        | —        | Subtitle.                                                                               |
| `enabled`           | boolean                   | no                        | `true`   | `false` keeps the entry in the file but stops it being read.                            |
| `refreshIntervalMs` | integer, 30000 – 86400000 | no                        | `300000` | Cache TTL for this provider.                                                            |
| `credentials`       | credential map            | no                        | `{}`     | See [Credentials](CREDENTIALS.md#credentials).                                                        |
| `source`            | source object             | no                        | —        | Omit only when every reading is schedule-driven and needs no request.                   |
| `readings`          | array of readings, min 1  | required without `preset` | —        | See [Readings](#readings).                                                              |

`unverified` is not settable from config. It is a property of a preset, marking one whose endpoint no vendor has published.

## Preset merge rules

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

## Readings

`readings` is a list discriminated on `kind`. Shared fields:

| Field   | Type   | Required | Notes                                                                                                                                               |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | string | yes      | Stable within the provider. With `each`, this is the prefix and `idPath` supplies the per-element part.                                             |
| `label` | string | yes      | Bar label.                                                                                                                                          |
| `group` | string | no       | Groups readings inside one card. A vendor that meters Google and non-Google models separately gets one group per family, each with its own windows. |

### `kind: "quota"`

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

### `window`

| Field             | Type      | Required | Notes                                                                                |
| ----------------- | --------- | -------- | ------------------------------------------------------------------------------------ |
| `label`           | string    | yes      | Names the bucket: `"Session"`, `"Weekly"`.                                           |
| `resetsAtPath`    | JSON path | no       | ISO timestamp, epoch seconds, or epoch milliseconds; all normalise to an ISO string. |
| `resetsInSecPath` | JSON path | no       | Seconds from the injected reading time; used when `resetsAtPath` does not resolve.   |
| `durationMs`      | integer   | no       | How long the window lasts, as a literal.                                             |
| `durationMsPath`  | JSON path | no       | Same, read from the response.                                                        |

With both a reset time and a duration, the bar can show how much of the window has elapsed, marking where even consumption would put you.

Supply a duration only when you actually know it. Several presets deliberately omit it — the `kimi` window and the `minimax` interval windows carry a reset time but no `durationMs`, because those window lengths are unpublished. Those bars show when the window resets and no pace marker, which is the honest rendering of what the vendor tells us.

### `kind: "balance"`

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

### Scaling an amount

`scale` multiplies every **amount** a reading resolves — `used`, `limit`, `remaining`, `total`. It never touches a percentage, because a percentage is already normalised and scaling one would be meaningless. Any non-zero number is accepted; zero is rejected, since it would erase the reading.

It exists because two real vendors report amounts in units nobody wants to read:

| Preset      | `scale`  | Why                                                                                                                           |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `novita`    | `0.0001` | It reports credit in ten-thousandths of a dollar, so `12500` means $1.25.                                                     |
| `deepinfra` | `-1`     | Its docs state verbatim that a **negative** `stripe_balance` means funds ready to spend, and a positive one means money owed. |

`deepinfra` is the interesting case: without `scale` the bar would show a debt where you have credit, and the sign convention is documented rather than inferred. Flipping it in config keeps the fix next to the mapping it corrects, instead of hiding a vendor quirk in code.

### `kind: "rate"`

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

`days` exists because peak pricing is usually a working-week concept. DeepSeek's peak hours are weekdays only, so without it a schedule would report peak pricing all weekend — see [A schedule-only rate provider](RECIPES.md#a-schedule-only-rate-provider).

### `each`

Projects one reading per element of an array, for vendors that report a variable number of buckets — one per model, one per limit. Every other path in the mapping becomes **relative to the element**.

| Field       | Type      | Required | Notes                                         |
| ----------- | --------- | -------- | --------------------------------------------- |
| `path`      | JSON path | yes      | Path to the array, from the document root.    |
| `idPath`    | JSON path | no       | Per-element id part, relative to the element. |
| `labelPath` | JSON path | no       | Per-element label.                            |
| `groupPath` | JSON path | no       | Per-element group.                            |

## Source

`source` is discriminated on `kind`.

### `kind: "http"`

| Field     | Type                | Required | Default | Notes                                                              |
| --------- | ------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `url`     | string              | yes      | —       | `${NAME}` expands from the credential chain.                       |
| `method`  | `"GET"` \| `"POST"` | no       | `"GET"` |                                                                    |
| `headers` | string→string map   | no       | `{}`    | `${NAME}` expands in each value.                                   |
| `body`    | any JSON            | no       | —       | Sent as-is. Only meaningful for `POST`. String leaves interpolate. |
| `failure` | failure object      | no       | —       | Where a 200 response says no. See below.                           |

#### `failure`

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

### `kind: "command"`

| Field     | Type            | Required | Notes                                                                       |
| --------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `command` | string[], min 1 | yes      | argv, not a shell line. The command must print one JSON document on stdout. |
| `cwd`     | string          | no       | Working directory. Defaults to the daemon's.                                |

`${NAME}` expands in every argv entry and in `cwd`.

### `kind: "file"`

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

The first line means the override is not in use here. The second means whatever writes the file has not run. See [Reading Claude quota without a token](CREDENTIALS.md#reading-claude-quota-without-a-token).

### `kind: "probe"`

| Field   | Type            | Required | Notes                              |
| ------- | --------------- | -------- | ---------------------------------- |
| `probe` | `"antigravity"` | yes      | Names a mechanism shipped as code. |

```json
{ "kind": "probe", "probe": "antigravity" }
```

The escape hatch for a vendor whose numbers no url can express. Where `http` and `command` describe _how_ to fetch, a probe just names a mechanism the plugin implements internally — because the real answer involves reading a stored credential, refreshing a token, and calling an endpoint that is not documented anywhere. That cannot be spelled as a url, so it is code, and the config only names it.

The set of probes is closed: only the values in the table above are accepted, so a probe cannot be pointed at anything new from config.

**Naming a probe is how a provider opts into a mechanism its vendor never documented, so every probe-backed preset stays flagged `unverified`** — not because it does not work, but because nothing about it is promised. See [Antigravity](PRESETS.md#antigravity).

### Timeouts and limits

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

## JSON paths

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
