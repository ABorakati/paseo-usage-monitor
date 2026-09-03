# Recipes

Every block below is a complete `usage-limits.json`.

## A preset with a key from the environment

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

## A hand-written HTTP provider

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

The URL and every path are placeholders. Substitute your vendor's own, then check them against a real response (see [Troubleshooting](TROUBLESHOOTING.md#troubleshooting)).

## A local command that prints JSON

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

## A schedule-only rate provider

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

## An `each` projection over a per-model array

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

See `usage-limits.example.json` at the plugin root for one file combining a preset, an override, a hand-written provider, a command provider, and a schedule-only rate.
