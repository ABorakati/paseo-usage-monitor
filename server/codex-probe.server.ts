/**
 * Codex reports its quota at `GET /backend-api/wham/usage`, and for an
 * individual subscription the `credits` object there carries the prepaid
 * amount. An education or workspace account gets the same object with
 * `has_credits: true` and `balance: null`: the backend says credits exist but
 * refuses to put a number in that field, while ChatGPT's own usage page shows
 * the remaining credits. The same number is readable with the same bearer
 * token from the per-user monthly spend control:
 *
 *   GET /backend-api/accounts/<accountId>/spend-controls/current-user/monthly-usage
 *   {"balance_unit":"credit",
 *    "effective_monthly_limit":{"limit":8000,"enforcement_mode":"HARD_CAP",…},
 *    "current_month_usage":204.36}
 *
 * That route is the web app's, not a documented public API, so it is read on a
 * best-effort basis: when it refuses or does not answer, the usage document
 * still renders and only the credits row is left blank. `/accounts/<id>/
 * remaining_balance` is deliberately not used — it answers 401 "Only accounts
 * with admin rights can perform this action" for a member.
 *
 * The probe merges one synthetic key into the vendor's own document so the
 * preset can project both credit regimes through a single reading:
 *
 *   codex_credits.remaining  prepaid credits, when the usage route reports them
 *   codex_credits.used       this month's spend, when only the cap route has a number
 *   codex_credits.total      the month's allowance, when only the cap route has a number
 *
 * `remaining` wins when present; the balance projection derives it from
 * `total - used` otherwise.
 */

import { accountIdFromToken } from "./codex-account.server";
import { UsageCredentialMissingError } from "./errors.server";
import { readAtPath, readNumberAtPath, readStringAtPath } from "./json-path.server";
import type { UsageHttpRequest } from "./source.server";

const CHATGPT_BACKEND = "https://chatgpt.com/backend-api";
const USAGE_URL = `${CHATGPT_BACKEND}/wham/usage`;
const MONTHLY_USAGE_PATH = "/spend-controls/current-user/monthly-usage";

export interface CodexProbeAdapters {
  fetchJson(request: UsageHttpRequest): Promise<unknown>;
  /** Resolves a credential the codex preset declared, by name. */
  resolve(name: string): string;
}

export interface CodexCreditsView {
  remaining: number | null;
  used: number | null;
  total: number | null;
}

function monthlyUsageUrl(accountId: string): string {
  return `${CHATGPT_BACKEND}/accounts/${encodeURIComponent(accountId)}${MONTHLY_USAGE_PATH}`;
}

/**
 * The account id name is optional: a token that is not a JWT (or an API-key
 * account) has no claim to read, and without an account id the cap route
 * cannot be addressed. The usage document itself needs no account id, so a
 * missing one downgrades credits to "unknown" rather than failing the card.
 */
function optionalAccountId(adapters: CodexProbeAdapters): string | null {
  try {
    return adapters.resolve("accountId");
  } catch (error) {
    if (error instanceof UsageCredentialMissingError) return null;
    throw error;
  }
}

/**
 * The cap route describes a monthly allowance in credits. A document that
 * states another unit cannot be projected by a reading whose unit is `credits`,
 * so it is treated as "no number" rather than mislabelled.
 */
function monthlyCreditsView(document: unknown): CodexCreditsView | null {
  const unit = readStringAtPath(document, "balance_unit");
  if (unit !== null && unit !== "credit" && unit !== "credits") return null;
  const used = readNumberAtPath(document, "current_month_usage");
  const total = readNumberAtPath(document, "effective_monthly_limit.limit");
  if (used === null || total === null || total <= 0) return null;
  return { remaining: null, used, total };
}

async function readMonthlyCredits(
  accountId: string,
  adapters: CodexProbeAdapters,
  headers: Record<string, string>,
): Promise<CodexCreditsView | null> {
  try {
    const document = await adapters.fetchJson({
      url: monthlyUsageUrl(accountId),
      method: "GET",
      headers,
    });
    return monthlyCreditsView(document);
  } catch {
    // Best effort by design: the usage route answered, so the card has real
    // windows to show. A refused cap route costs the credits number, not the
    // reading, and a 429 here must not put the whole provider into backoff.
    return null;
  }
}

async function creditsView(
  usage: unknown,
  adapters: CodexProbeAdapters,
  headers: Record<string, string>,
  accountId: string | null,
): Promise<CodexCreditsView | null> {
  const prepaid = readNumberAtPath(usage, "credits.balance");
  if (prepaid !== null) return { remaining: prepaid, used: null, total: null };
  if (readAtPath(usage, "credits.has_credits") !== true) return null;
  // Unlimited credits have no remaining number to show, and asking the cap
  // route about them would invent a ceiling the account does not have.
  if (readAtPath(usage, "credits.unlimited") === true) return null;
  if (accountId === null) return { remaining: null, used: null, total: null };
  return (
    (await readMonthlyCredits(accountId, adapters, headers)) ?? {
      remaining: null,
      used: null,
      total: null,
    }
  );
}

export async function probeCodexUsage(adapters: CodexProbeAdapters): Promise<unknown> {
  const token = adapters.resolve("token");
  const accountId = accountIdFromToken(token) ?? optionalAccountId(adapters);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(accountId === null ? {} : { "ChatGPT-Account-Id": accountId }),
  };
  const usage = await adapters.fetchJson({ url: USAGE_URL, method: "GET", headers });
  if (usage === null || typeof usage !== "object") return usage;
  const view = await creditsView(usage, adapters, headers, accountId);
  return view === null ? usage : { ...usage, codex_credits: view };
}
