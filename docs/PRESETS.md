# Presets

Start here, because the shape of the answer is not obvious: **an ordinary API key that can read its own balance is the exception, not the norm.** DeepSeek can. Most frontier labs cannot — they gate usage behind a separate admin or organisation credential, or expose it only in per-request response headers that a poller can never see. So before looking for your provider in the table, know which of five cases you are in:

| Kind                        | What you get                                                    | Needs                                       |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| **Subscription/plan quota** | Consumption inside a resetting window, as a percentage or count | The CLI's own login, or a plan-specific key |
| **API-key balance**         | Money or credits left                                           | An ordinary API key                         |
| **Aggregator**              | Spend against a cap, per key or per account                     | An ordinary API key                         |
| **Pricing band**            | Which rate is in force now                                      | Nothing                                     |
| **Template**                | Nothing yet — a shape to repoint                                | An endpoint that does not exist yet         |

If your provider is not in the table below, read [What is not supported, and why](#what-is-not-supported-and-why) before assuming it was overlooked. The absence is usually the vendor's, not this plugin's.

## The 34 presets

| Preset                          | Kind         | Reads                                                         | Endpoint                                                                         | Credential         | Sources, tried in order                                                                                                     |
| ------------------------------- | ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `claude`                        | Subscription | Session, weekly and per-model limits                          | `GET https://api.anthropic.com/api/oauth/usage`                                  | `token`            | `claudeAiOauth.accessToken` in `${CLAUDE_CONFIG_DIR}/.credentials.json`, then `~/.claude/.credentials.json`                 |
| `claude-statusline`             | Subscription | Session and weekly limits                                     | None — reads `~/.claude/paseo-rate-limits.json`                                  | —                  | Its own statusline hook writes the file; nothing is authenticated                                                           |
| `codex`                         | Subscription | Session, weekly, code-review, reserve, banked resets, credits | `GET https://chatgpt.com/backend-api/wham/usage`                                 | `token`            | `tokens.access_token` in `${CODEX_HOME}/auth.json`, then `~/.codex/auth.json`, then `~/.config/codex/auth.json`             |
| `cursor`                        | Subscription | Plan spend, limit and remaining balance                       | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` | `token`            | `CURSOR_ACCESS_TOKEN`, `CURSOR_TOKEN`, then `${CURSOR_HOME}/auth.json`, `~/.config/cursor/auth.json`, `~/.cursor/auth.json` |
| `grok`                          | Subscription | Monthly credit limit and usage                                | `GET https://cli-chat-proxy.grok.com/v1/billing`                                 | `token`            | `GROK_API_KEY`, `GROK_TOKEN`, then `${GROK_HOME}/auth.json`, `~/.grok/auth.json`, `~/.config/grok/auth.json`                |
| `github-copilot`                | Subscription | Metered request buckets for the month                         | Probe (`probe: "github-copilot"`)                                                | —                  | `COPILOT_GITHUB_TOKEN`, then the Copilot extensions' own token in `~/.config/github-copilot/hosts.json`, `apps.json`        |
| `kimi`                          | Subscription | Coding request allowance for the window                       | `GET https://api.kimi.com/coding/v1/usages`                                      | `token`            | `KIMI_TOKEN`, `KIMI_API_KEY`, then `${KIMI_CODE_HOME}/credentials/kimi-code.json`, `~/.kimi-code/…`, `~/.kimi/…`            |
| `minimax`                       | Subscription | Per-model consumption, rolling + weekly                       | `GET https://api.minimax.io/v1/token_plan/remains`                               | `token`            | `MINIMAX_API_KEY`, then `~/.mmx/credentials.json`, then `~/.mmx/config.json`                                                |
| `minimax-cn`                    | Subscription | The same, on the mainland host                                | `GET https://api.minimaxi.com/v1/token_plan/remains`                             | `token`            | `MINIMAX_CN_API_KEY`, then `MINIMAX_API_KEY`                                                                                |
| `zai-coding-plan` (alias `zai`) | Subscription | Session, weekly and monthly MCP-call windows                  | `GET https://api.z.ai/api/monitor/usage/quota/limit`                             | `apiKey`           | `Z_AI_API_KEY`, `ZAI_API_KEY`, then `GLM_API_KEY`                                                                           |
| `zhipuai-coding-plan`           | Subscription | The same, on the mainland host                                | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`                     | `apiKey`           | `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY`, then `BIGMODEL_API_KEY`                                                                 |
| `synthetic`                     | Subscription | Requests used against the plan limit                          | `GET https://api.synthetic.new/v2/quotas`                                        | `apiKey`           | `SYNTHETIC_API_KEY`                                                                                                         |
| `opencode-go`                   | Subscription | Rolling 5-hour, weekly and monthly usage                      | `GET https://opencode.ai/zen/go/v1/usage`                                        | `apiKey`           | `OPENCODE_API_KEY`                                                                                                          |
| `chutes`                        | Subscription | Rolling requests and monthly credits                          | `GET https://api.chutes.ai/users/me/subscription_usage`                          | `apiKey`           | `CHUTES_API_KEY`                                                                                                            |
| `zenmux`                        | Subscription | Rolling 5-hour and 7-day flow quotas                          | `GET https://zenmux.ai/api/v1/management/subscription/detail`                    | `apiKey`           | `ZENMUX_MANAGEMENT_API_KEY`                                                                                                 |
| `antigravity`                   | Subscription | Per-family session and weekly quotas                          | Probe (`probe: "antigravity"`)                                                   | —                  | The user's own OAuth entry in the OS keyring                                                                                |
| `deepseek`                      | Balance      | Prepaid balance and granted credit                            | `GET https://api.deepseek.com/user/balance`                                      | `apiKey`           | `DEEPSEEK_API_KEY`                                                                                                          |
| `moonshot`                      | Balance      | Platform balance, USD                                         | `GET https://api.moonshot.ai/v1/users/me/balance`                                | `apiKey`           | `MOONSHOT_API_KEY`                                                                                                          |
| `moonshot-cn`                   | Balance      | Platform balance, domestic host                               | `GET https://api.moonshot.cn/v1/users/me/balance`                                | `apiKey`           | `MOONSHOT_API_KEY`                                                                                                          |
| `siliconflow`                   | Balance      | Prepaid balance                                               | `GET https://api.siliconflow.com/v1/user/info`                                   | `apiKey`           | `SILICONFLOW_API_KEY`                                                                                                       |
| `siliconflow-cn`                | Balance      | Prepaid balance, domestic host                                | `GET https://api.siliconflow.cn/v1/user/info`                                    | `apiKey`           | `SILICONFLOW_API_KEY`                                                                                                       |
| `stepfun-ai`                    | Balance      | Available balance, USD                                        | `GET https://api.stepfun.ai/v1/accounts`                                         | `apiKey`           | `STEPFUN_API_KEY`                                                                                                           |
| `stepfun`                       | Balance      | Available balance, domestic host                              | `GET https://api.stepfun.com/v1/accounts`                                        | `apiKey`           | `STEPFUN_API_KEY`                                                                                                           |
| `novita`                        | Balance      | Balance against the account credit limit                      | `GET https://api.novita.ai/openapi/v1/billing/balance/detail`                    | `apiKey`           | `NOVITA_API_KEY`                                                                                                            |
| `deepinfra`                     | Balance      | Prepaid balance                                               | `GET https://api.deepinfra.com/payment/checklist`                                | `apiKey`           | `DEEPINFRA_API_KEY`                                                                                                         |
| `venice`                        | Balance      | DIEM epoch allowance and USD balance                          | `GET https://api.venice.ai/api/v1/billing/balance`                               | `apiKey`           | `VENICE_API_KEY`                                                                                                            |
| `xai`                           | Balance      | Prepaid team credit, USD                                      | `GET https://management-api.x.ai/v1/billing/teams/${teamId}/prepaid/balance`     | `apiKey`, `teamId` | `XAI_MANAGEMENT_API_KEY`; `XAI_TEAM_ID`                                                                                     |
| `nano-gpt`                      | Balance      | USD balance and Nano balance                                  | `POST https://nano-gpt.com/api/check-balance`                                    | `apiKey`           | `NANOGPT_API_KEY`                                                                                                           |
| `poe`                           | Balance      | Points left                                                   | `GET https://api.poe.com/usage/current_balance`                                  | `apiKey`           | `POE_API_KEY`                                                                                                               |
| `openrouter`                    | Aggregator   | Spend cap on the current key                                  | `GET https://openrouter.ai/api/v1/key`                                           | `apiKey`           | `OPENROUTER_API_KEY`                                                                                                        |
| `openrouter-credits`            | Aggregator   | Account-wide credits purchased vs used                        | `GET https://openrouter.ai/api/v1/credits`                                       | `apiKey`           | `OPENROUTER_API_KEY`                                                                                                        |
| `vercel`                        | Aggregator   | Team AI Gateway credit balance, USD                           | `GET https://ai-gateway.vercel.sh/v1/credits`                                    | `apiKey`           | `AI_GATEWAY_API_KEY`, then `VERCEL_AI_GATEWAY_API_KEY`                                                                      |
| `deepseek-rate`                 | Pricing band | Which pricing band is in force                                | None — schedule only                                                             | —                  | None                                                                                                                        |
| `opencode-zen`                  | Template     | Nothing yet                                                   | `https://example.invalid/zen/v1/balance`                                         | `apiKey`           | `OPENCODE_ZEN_API_KEY` (placeholder)                                                                                        |

`zai` is an alias of `zai-coding-plan`: the same route, readings and credential chain under a shorter id, labelled `Z.ai`. Both ids resolve, so a config written against either keeps working.

Every endpoint above was verified against the vendor's own documentation or a recorded working implementation, with the exceptions called out below. The balance endpoints marked corroborated were additionally cross-checked against a working implementation that has to keep them running in production — one-api / new-api for the older balance routes, CodexBar for the coding-plan and subscription routes — which is a useful second opinion.

Corroborated: `deepseek`, `moonshot`, `moonshot-cn`, `siliconflow`, `siliconflow-cn`, `stepfun`, `novita`, `deepinfra`, `openrouter-credits`, `zai-coding-plan`, `zhipuai-coding-plan`, `minimax-cn`, `opencode-go`, `chutes`, `zenmux`.

The exceptions. **`zai-coding-plan`** and **`zhipuai-coding-plan`** read the route Z.ai's own usage-query plugin calls; the vendor documents the plugin, not the route, so the shape is recorded from the vendor's script and CodexBar's fixtures. **`opencode-go`** uses the live public route and the response names recorded by CodexBar's API parser test. **`chutes`** uses the self-scoped route and response fixture in CodexBar's fetcher tests because Chutes publishes no response schema for it. **`github-copilot`** reads a route GitHub does not document at all, so it is a probe rather than an http preset — see [GitHub Copilot](#github-copilot).

A file source above may also declare `expiresAtPath`, so a token the owning CLI has stopped refreshing is skipped rather than spent. `claude`, `kimi` and `minimax` do; `codex` cannot, and the reason is worth reading — see [Expiry](CREDENTIALS.md#expiry).

## Per-preset caveats

The ones with a trap in them:

- **`minimax`** needs a **Token Plan subscription key**, which the vendor issues separately from an ordinary pay-as-you-go API key. It also reports _consumption inside rolling 5-hour and weekly windows_, not a balance, so it is a quota rather than a balance despite being a paid API.
- **`moonshot` vs `moonshot-cn`** are host-locked: a key from one host returns 401 on the other. Pick the one matching where your account lives. `moonshot` is also the _platform_ key, not the coding-plan key `kimi` uses. `moonshot-cn` shows its amount unitless, because the domestic account is understood to bill in CNY and no source confirms the currency the field actually carries.
- **`siliconflow` vs `siliconflow-cn`** read the international and domestic hosts, which share a response shape but not a currency. The domestic one shows its amount unitless, as `moonshot-cn` does, because that account bills in CNY.
- **`novita`** reports credit in **ten-thousandths of a dollar**, handled by `scale: 0.0001` — see [Scaling an amount](CONFIGURATION.md#scaling-an-amount).
- **`deepinfra`** reports a prepaid balance as a **negative number**, handled by `scale: -1`.
- **`venice`** returns both a DIEM epoch quota and a USD balance in one call. Which one actually bills depends on the account's consumption currency, so both are shown rather than guessing.
- **`openrouter` vs `openrouter-credits`** answer different questions. The first is the spend cap on _the key you are using_; an unlimited key reports no numbers at all, which is correct and not a failure. The second is _account-wide_ credits purchased against credits used. A 401 from `openrouter-credits` means the key is not provisioned for the credits endpoint, not that the credential is wrong.
- **`claude`** polls every 30 minutes because its endpoint throttles hard — see [Rate limits](#rate-limits). **`claude-statusline`** reads the same two windows from a local file every minute instead, with no credential and no request — see [Reading Claude quota without a token](CREDENTIALS.md#reading-claude-quota-without-a-token).
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

## Verified and unverified

Every preset except `antigravity`, `github-copilot`, `deepseek-rate`, `claude-statusline` and `xai` declares exactly one credential name — `token` or `apiKey`, per the table. That is the name to re-declare when repointing a preset's key. `claude`, `codex` and `kimi` try several locations in order, so they keep working whether or not you have set the CLI's home-directory variable. `xai` declares two names, `apiKey` and `teamId`, because its balance route is per team and the team id lives in the url; the id is not a secret, but the credential map is the only thing that interpolates into a url, so it is stored like one. The remaining four declare none: `antigravity` and `github-copilot` read their credentials themselves, and the other two need no credential at all.

`unverified` does not mean broken. It means **the vendor promises nothing**, so the numbers may stop arriving without warning. The three unverified presets are unverified for two different reasons:

- **`antigravity`** — it works, and the numbers are real. What is missing is any published API: it reads them the way described in [Antigravity](#antigravity), which is undocumented by Google and could break at any time.
- **`github-copilot`** — the same shape. GitHub documents the limits and not the route, so the probe described in [GitHub Copilot](#github-copilot) calls the endpoint the official IDE extensions call, and could break with the extensions.
- **`opencode-zen`** — it does not work yet, by design. A balance endpoint is an open, unimplemented upstream feature request, so this preset is a **shape** — the right readings for that vendor — on a deliberately unroutable `example.invalid` host. Repoint `source` once an endpoint ships. Out of the box it fetches nothing and fails loudly.

The correspondence is enforced by a test, in both directions: a probe-backed preset must be flagged `unverified`, and an HTTP preset's url contains `example.invalid` exactly when it is flagged. So no verified preset can quietly point at a placeholder, and no placeholder can quietly claim to be verified. A `file` source contacts no host at all, so there is no guessed endpoint it could hide; what makes it verified is that its field names are the local tool's own, and a second test holds it to declaring no credential.

A guessed URL presented as fact is worse than a documented gap. That is why `opencode-zen` points at `example.invalid` rather than somewhere plausible.

You do not have to read this table to see any of it. The [Usage providers](../README.md#editing-providers-from-the-app) surface lists every preset with its endpoint, a hint describing how its credential resolves, and an **Unverified** badge where it applies.

## What is not supported, and why

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

A `command` source that wraps the vendor's CLI is the honest route for the CLI-backed ones; see [A local command that prints JSON](RECIPES.md#a-local-command-that-prints-json).

**Dead.** OpenAI's legacy `/v1/dashboard/billing/*` pair no longer works for API keys, despite still being present in one-api. It is not coming back.

**Out of scope.** AIProxy and API2GPT are resellers rather than first-party providers.

If a vendor ships an endpoint, none of this needs a code change — write a provider entry, or add one through the Usage providers surface.

## Antigravity

This one works. Live output on this machine:

| Bucket          | Window  | Group                 | Used   | Resets               |
| --------------- | ------- | --------------------- | ------ | -------------------- |
| `gemini-5h`     | Session | Gemini Models         | 9.23%  | 2026-08-28T22:11:13Z |
| `gemini-weekly` | Weekly  | Gemini Models         | 25.06% | 2026-09-01T20:00:00Z |
| `3p-5h`         | Session | Claude and GPT models | 0%     | —                    |
| `3p-weekly`     | Weekly  | Claude and GPT models | 0%     | —                    |

Two shared pools, each with a rolling 5-hour and a weekly window. That is exactly the model-family-plus-two-windows shape the `group` field and the `each` projection were designed for. All four buckets are always emitted, with null readings when the response omits one, so a missing bucket never shifts the others.

### The quota bars are one ledger, not all of your usage

`retrieveUserQuotaSummary` answers for the **consumer Antigravity plan**. A request that runs under your own Cloud project is billed elsewhere and never decrements those buckets, and that is exactly how Paseo reaches the model: the `google-antigravity` credential omp stores carries a `projectId`, so its traffic is on the standard-tier path.

Measured here, with both credentials on the same Google account: `gemini-weekly` held `0.7627758` remaining at 18:50Z and the identical figure at 19:45Z, across 465 requests and 75M tokens of Paseo traffic. `gemini-5h` read `remainingFraction: 1` throughout. The bars were right; they were answering a different question.

So the card leads with what each Antigravity client on this machine actually spent, from the logs each one writes, and the vendor pool follows it as **Plan pool · Session** and **Plan pool · Weekly**:

| Group             | Source                                                                     | Rows                                                             |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Antigravity app` | `~/.gemini/antigravity/conversations/*.db`                                 | Tokens (5h, 7d), requests (24h)                                  |
| `Antigravity CLI` | `~/.gemini/antigravity-cli/conversations/*.db`                             | Tokens (5h, 7d), requests (24h)                                  |
| `Antigravity ACP` | `~/.gemini/antigravity-acp/conversations/*.db`                             | Tokens (5h, 7d), requests (24h)                                  |
| `Paseo (omp)`     | the omp transcripts the [history](HISTORY.md) surface already reads         | Tokens (5h, 7d), requests (24h), spend (7d)                      |

A group with nothing in the widest window contributes no rows, so a client you do not have installed costs you no zeros. These rows carry a `used` figure and no ceiling, because no client publishes the limit its plan applies — a bar would have to invent one.

Each conversation store is SQLite, and one `steps` row is one turn. The `metadata` blob is protobuf with no schema published anywhere, so only two fields are read: the step's timestamp, and the generation's usage counters (uncached input, cached input, output). The output counter is reported twice — once whole, once split in two — and the reader drops any row where the split does not add up. That identity held on 261 of 261 live rows, and it is what distinguishes a decoded counter from a guessed one. A vendor schema change therefore shows up as a missing row, never as a wrong number.

Only stores touched inside the window are opened, and each is walked newest-first and abandoned at the first turn older than the window. A full read of 21 recently-used stores took 368 ms here; the other 152 on disk were never opened.

### How it works

You should know this before enabling it, so you can judge it yourself. Google publishes no Antigravity quota API. The probe:

1. Reads your own Antigravity OAuth credential from the OS keyring — a Secret Service item over D-Bus on Linux, the equivalent Keychain generic password on macOS (service `gemini`, account `antigravity`). It never writes to that item.
2. Obtains Antigravity's OAuth client id and secret by scanning the installed `agy` binary, rather than hardcoding them, so the plugin ships no vendor secret and follows whatever your install has.
3. Refreshes the access token against `https://oauth2.googleapis.com/token`, because a stored token lasts an hour and is usually stale. The refresh returns no new refresh token, so your stored credential is left exactly as Antigravity wrote it.
4. POSTs to `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` — an undocumented Cloud Code endpoint — with that token.

The method was derived from ClaudeBar's probe. ClaudeBar's _primary_ path is different: a Connect-protocol call to a running Antigravity `language_server` over loopback, authenticated with a CSRF token scraped from the process command line. That path found nothing here, because no Antigravity IDE or language server runs on this machine, so this plugin does not implement it and uses the keyring route above instead.

### The risks

This impersonates the Antigravity client rather than using a published API. Concretely: it may violate Google's terms of service, it can break without notice, and it touches both your OS keyring and a vendor binary on disk. Those are real costs, not theoretical ones.

So it is opt-in, it stays flagged `unverified`, and the flag is shown on the card. **If you are not comfortable with the above, do not enable it** — and if you enabled it and changed your mind, remove it with one click in the [Usage providers](../README.md#editing-providers-from-the-app) surface.

## GitHub Copilot

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

## Rate limits

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

### What a 429 does

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
