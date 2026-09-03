# Multiple accounts on one provider

Nothing ties a provider entry to a preset name. The root of `usage-limits.json` is a map from **provider id** to entry, and the id is whatever you choose within `^[a-z][a-z0-9-]*$`. Two entries that name the same `preset` are two independent providers: each has its own card, its own cache slot, its own stored reading, and its own credential chain. That is all multi-account support is, and it needs no switch to turn on.

## Ids are arbitrary

`"codex": { "preset": "codex" }` is the default, but `"codex-work": { "preset": "codex" }` is just as valid. The preset supplies the endpoint and readings; the id is the key the rest of the plugin uses to keep the two apart:

- **Cache.** Each id is cached for its own `refreshIntervalMs`, so refreshing one account does not touch the other.
- **Stored readings.** The last good reading is persisted per id, so a rate-limited or rejected account keeps its own numbers on screen while the other keeps updating.
- **Card order.** Dragging a card writes `display.order` onto that id's entry, so each account keeps its own place on the board.
- **Secrets.** A key typed into the UI is stored under the id, never under the preset name (see below).

Every field on an entry replaces the preset's field wholesale except `credentials`, which merge by name. The rules are in [Preset merge rules](CONFIGURATION.md#preset-merge-rules). For a second account the two fields you care about are `label`, so the cards read differently, and `credentials`, so each card authenticates as its own account.

## The Provider id field

The **Usage providers** surface exposes the id directly. The Add provider and Edit provider forms both open with a **Provider id** field at the top. Picking a preset prefills it with the preset's own id; change it before saving and you get a second instance of that preset under the new id. The form refuses an id that does not match the pattern above.

Two things the form does **not** do for a preset-based entry:

- It does not show a **Label** field. A preset entry saved from the form carries the preset's label, so two `codex` instances would both read `Codex`. Set `label` by hand in `usage-limits.json` to tell them apart.
- It does not let you repoint the preset's credential chain. A key typed into the form is **appended after** the preset's own sources, with any environment-variable sources kept first, exactly as [Where a typed key goes](../README.md#where-a-typed-key-goes) describes. For a preset that authenticates from a CLI's own file, such as `codex`, that file still wins, so a typed key does not switch the card to another account. Re-declare the credential by hand instead (see the recipe).

Once you have hand-edited a preset entry, do not save it from the form again. The form writes a preset entry as `preset` plus `display` only, so `label`, `credentials`, `refreshIntervalMs` and every other override is dropped and the card silently falls back to the preset's own chain. Dragging cards on the Usage Monitor surface is safe: it rewrites `display.order` and keeps the rest of the entry.

Custom providers have none of these limits: the form shows the label and the credential chain is whatever you build.

## Secrets stay isolated per id

Secrets typed into the UI live in a sibling file, `${PASEO_HOME:-~/.paseo}/usage-limits.secrets.json`, written with owner-only permissions. Its root is a map from provider id to a map of credential name to value:

```json
{
  "openrouter-personal": { "apiKey": "sk-or-..." },
  "openrouter-work": { "apiKey": "sk-or-..." }
}
```

The provider entry then references its own value through an ordinary `jsonFile` credential whose `path` is `providerId.name`:

```json
{
  "kind": "jsonFile",
  "file": "/home/you/.paseo/usage-limits.secrets.json",
  "path": "openrouter-work.apiKey"
}
```

Because the path carries the id, two accounts on the same preset never share a key, and removing one provider deletes only its own branch of the secrets file. The main config never holds a value, only that reference, so it stays safe to paste into an issue whatever accounts it lists.

## Recipe: two Codex accounts

The `codex` preset reads the token Codex CLI wrote to `${CODEX_HOME}/auth.json`, `~/.codex/auth.json`, or `~/.config/codex/auth.json`, in that order. A second account needs its own login kept in its own directory, which Codex CLI supports through `CODEX_HOME`:

```bash
CODEX_HOME=~/.codex-work codex login
```

Then give each account its own entry. `codex-personal` keeps the preset's default chain; `codex-work` re-declares `token` so it reads only the work login:

```json
{
  "codex-personal": {
    "preset": "codex",
    "label": "Codex (personal)"
  },
  "codex-work": {
    "preset": "codex",
    "label": "Codex (work)",
    "credentials": {
      "token": [
        {
          "kind": "jsonFile",
          "file": "~/.codex-work/auth.json",
          "path": "tokens.access_token",
          "refreshedBy": "codex"
        }
      ]
    }
  }
}
```

`credentials` merges by name, so re-declaring `token` replaces the whole chain for that one name and nothing else on the preset changes. `refreshedBy` is optional; with it a rejected-credential notice reads "Run `codex` so it refreshes ~/.codex-work/auth.json." instead of the generic "Run the CLI that owns ~/.codex-work/auth.json so it refreshes the stored token." Because this file exists, the built-in defaults no longer apply, so add `"claude": { "preset": "claude" }` if you still want the Claude card (see [Defaults](../README.md#defaults)).

Both cards poll the same endpoint with different tokens, so each account's rate-limit budget is its own. Use the **Test** action on each to confirm which login it resolved: a work card that reports the personal account's numbers means the chain still reaches `~/.codex/auth.json`.

The same shape works for any preset. For one that authenticates from an environment variable, point each entry's chain at a differently named variable, or type each key into the form and let the secrets file keep them apart.
