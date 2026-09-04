# Usage history

![Usage history](images/usage-history.png)

## Where the numbers come from

Paseo persists no usage time series. Its `lastUsage` is the latest turn only, it never reaches disk, and the plugin SDK does not expose it. Sampling forward from first run would mean an empty chart for a month.

So history is read out of the agent CLIs' own transcript logs, which already contain per-message token counts going back as far as you have kept them:

| CLI         | Scanned                                                                | Root override                                                                                           |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claude Code | `<root>/projects/**/*.jsonl`                                           | `CLAUDE_CONFIG_DIR` (comma-separated), else both `${XDG_CONFIG_HOME:-~/.config}/claude` and `~/.claude` |
| Codex       | `<root>/sessions/**/*.jsonl` and `<root>/archived_sessions/**/*.jsonl` | `CODEX_HOME` (comma-separated), else `~/.codex`                                                         |

A `CLAUDE_CONFIG_DIR` entry that already ends in `projects` is normalised to its parent. For Codex, if neither `sessions` nor `archived_sessions` yields files, the reader falls back to `<root>/**/*.jsonl`.

Reading files the CLIs own means history works retroactively on first launch, and it also means the plugin only ever reads. It writes nothing to either CLI's directory.

## Buckets

| Range | Bucket  | Buckets |
| ----- | ------- | ------- |
| `24h` | 1 hour  | 25      |
| `7d`  | 6 hours | 29      |
| `30d` | 1 day   | 31      |

Bucket starts are floor-aligned to the bucket size in UTC. The count is one more than the window divides into, because both ends are partial: flooring the window start reaches back before it, and the bucket containing _now_ is still filling. A 24h query therefore returns 25 hourly buckets, of which the first and last cover only part of their hour.

Every bucket in the window is emitted, including empty ones, so the chart has no gaps that look like missing data rather than idle time.

## Scan cost

A transcript directory grows without bound, so the reader stats every candidate before it reads any. A file is skipped without being opened when its mtime is older than the start of the window, when its size is zero, or when it exceeds 64 MiB (see [Scan failures](#scan-failures)). Rows that parse but fall outside the window are dropped afterwards.

That makes a 24h query cheap regardless of how much history you have accumulated, and it is why the `30d` view costs more than the `24h` one.

## Dedup

Transcripts duplicate records — resumed sessions, forks, copied project directories — so raw sums overcount badly.

- **Claude Code** dedups on `message.id`, falling back to `requestId` only when `message.id` is absent. On a collision the larger token total wins. On a tie, a normal record beats an `isSidechain: true` one.
- **Codex** dedups on the tuple of `timestamp`, `model`, and each token count (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`).

Both dedup maps are global across the whole scan, not per file, so duplicated and copied files collapse into one contribution.

## Series, expansion and colour

Each series is one agent CLI and `seriesKey` is its id (`claude-code`, `codex`, `omp-anthropic`). Every provider row also carries `children`: one row per model that provider ran, so expanding a provider costs no second request. A provider that ran exactly one model still gets a one-element `children` array, so the row opens onto that one model rather than looking inert.

Buckets carry values at both levels. A top-level row has `parentKey: null`; a model row has `parentKey` set to its provider's key. A bucket's own totals sum **only** the `parentKey: null` rows, so summing every value double-counts the window. Children cover 100% of their parent on all seven token counters and on cost, in every bucket, so expanding a provider never changes a column's height - it only subdivides it.

Grouping by model lifts every model to the top level with empty `children`, which is the only way to compare two models you reach through different tools.

The plotted-series cap applies per level. Which providers get a band is decided from the collapsed rows alone, so expanding one provider can never evict another provider's band; inside an expanded provider its own tail folds into an indented `Other` that reconciles to that provider, not to the window.

## Colour

`PluginTheme` exposes one accent and no categorical palette, so the series palette is derived from the theme rather than hardcoded, and it changes with the theme.

Hue carries category and lightness carries nesting. Top-level colours rotate hue evenly around the accent in OKLCH, holding lightness and chroma in a band chosen from the surface colours' mean luminance; the models inside an expanded provider keep the parent's hue and separate by lightness only. Neither axis borrows the other's job, so a dim provider band can never be mistaken for a bright neighbour's model.

Colours are gamut-mapped by giving up chroma while holding lightness and hue, because clipping RGB channels shifts hue and is how an even rotation lands two series on the same colour.

Every colour clears **3:1** against `surface0`, `surface1` and `surface2` - WCAG 2.1 SC 1.4.11, the non-text rule, because a band is a graphical object carrying meaning. All three surfaces are checked, not just the one a band sits on, since a legend swatch and a bar sit on different surfaces in the same view. The text rule of 4.5:1 was rejected deliberately: it forces every band toward the ends of the lightness range and collapses the hue separation the palette exists to provide. Measured worst case across the shipped themes is 3.67:1 at fourteen series.

An unparseable accent falls back rather than throwing, and a count of zero still yields one colour, so a malformed theme degrades instead of rendering a blank chart.

## Which metric, and why work is the default

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

## Cost

Cost is a fourth metric beside Work, Cached and Total, and it exists because tokens are not comparable across vendors. A cheap model can run several times another's tokens for a fraction of the money, so a token chart ranks providers in an order the invoice does not.

Two sources, in order. A log that reports its own cost wins - omp session transcripts carry `message.usage.cost.total`, and Claude Code carries a top-level `costUSD` (still `null` in current transcripts). Everything else is priced from LiteLLM's public rate table, fetched once and cached for 24 hours under `usage-limits/model-rates.json`.

The surface always says which, because a number you cannot date is a number you cannot trust: `Priced from today's rate table.`, `Priced from a rate table fetched 6h ago.`, or `Cost is unavailable: no rate table could be loaded, so these tokens cannot be priced.` - in which case the metric is disabled rather than showing zeros. Models the table could not price are named in that line.

Cache reads, cache writes and output are priced separately, since a cache read costs about a tenth of fresh input. Long-TTL cache writes are priced separately again: Anthropic bills a 1-hour cache write at 1.6x the 5-minute rate, and where a transcript uses 1-hour caching throughout, pricing that category flat understates it by 37.5%. `cacheSavingsUsd` reports what the cache reads saved against paying fresh input rates.

**A null cost is not a zero cost.** A series no rate could price stays visible and reads `unpriced`; any total containing one is `null` rather than a partial sum, and a `+` suffix marks a figure that is a floor. A wrong rate is worse than no rate, so model-id resolution never crosses a modality boundary on an inexact match - a text model will go unpriced rather than borrow an image model's price.

The original objection to a dollar figure still stands and is why it works this way: a price table _bundled_ into this plugin would drift out of date silently and report confident wrong numbers. Fetching the canonical table, caching it, and showing its age is a different thing.

## Known gaps

- **OpenCode** records usage in a SQLite database rather than JSONL. That database was empty on this machine, so nothing could be verified against it, and it is not read. Its usage does not appear in history.
- **Antigravity's own clients** keep their turns in per-conversation SQLite stores, not JSONL, so they contribute no series to this chart. Their token and request counts are read instead by the `antigravity` provider card, per client — see [Antigravity](PRESETS.md#antigravity). Antigravity models driven through omp do appear here, as `Google Antigravity (omp)`.

## Scan failures

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
