/**
 * Reads the signed-in Copilot seat's request allowances — premium requests,
 * and the chat and completion buckets where a plan meters them.
 *
 * GitHub documents the limits but publishes no route to read them, so this
 * goes through the internal endpoint the official Copilot IDE extensions call
 * on start-up, with the headers they send:
 *
 *   GET https://api.github.com/copilot_internal/user
 *   Authorization: token <the user's own Copilot OAuth token>
 *
 * The token is the one the Copilot extensions already stored for this
 * machine's login, in `hosts.json` (or `apps.json` on newer builds) under the
 * user's Copilot config directory, keyed by hostname. Nothing here writes to
 * those files, and nothing refreshes the token: it is long-lived and the
 * extensions own it. A personal access token is refused by this route, which
 * is why the environment override is named for Copilot rather than GitHub.
 *
 * Run directly to print the raw JSON on stdout, which is how a `command`
 * source would consume it:
 *
 *   node github-copilot-probe.server.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GithubCopilotBucket {
  id: string;
  label: string;
  entitlement: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  /** Present in the response and counted, so a bar is meaningful. */
  metered: boolean;
  unlimited: boolean;
  resetsAt: string | null;
}

export interface GithubCopilotQuota {
  source: string;
  fetchedAt: string;
  plan: string | null;
  resetsAt: string | null;
  buckets: GithubCopilotBucket[];
}

export class GithubCopilotProbeError extends Error {}

const USER_ENDPOINT = "https://api.github.com/copilot_internal/user";
const TOKEN_ENV_VARIABLE = "COPILOT_GITHUB_TOKEN";
const CREDENTIAL_FILES = ["hosts.json", "apps.json"] as const;
const HOSTNAME = "github.com";
const REQUEST_TIMEOUT_MS = 8_000;

/** The headers the Copilot Chat extension sends; the route refuses a bare request. */
const EXTENSION_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Editor-Version": "vscode/1.98.1",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "X-Github-Api-Version": "2025-04-01",
};

/**
 * The buckets `copilot_internal/user` reports, in a fixed order so a reading
 * addresses the same one forever. Every one is always emitted, flagged
 * `metered: false` when the response omits it or calls it unlimited, so an
 * absent bucket never shifts the others.
 */
const KNOWN_BUCKETS: readonly { id: string; key: string; label: string }[] = [
  { id: "premium", key: "premium_interactions", label: "Premium requests" },
  { id: "chat", key: "chat", label: "Chat" },
  { id: "completions", key: "completions", label: "Completions" },
];

export interface GithubCopilotProbeAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
  fetchJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; document: unknown }>;
  now(): Date;
}

export function createNodeGithubCopilotProbeAdapters(): GithubCopilotProbeAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    readTextFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    async fetchJson(url, headers) {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let document: unknown = null;
      try {
        document = JSON.parse(text);
      } catch {
        document = null;
      }
      return { status: response.status, document };
    },
    now: () => new Date(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/** Where the Copilot extensions keep their login, honouring the XDG override. */
export function copilotConfigDir(
  adapters: Pick<GithubCopilotProbeAdapters, "env" | "homeDir">,
): string {
  const xdg = adapters.env["XDG_CONFIG_HOME"];
  const base =
    xdg !== undefined && xdg.trim() !== "" ? xdg.trim() : join(adapters.homeDir, ".config");
  return join(base, "github-copilot");
}

/**
 * The file is keyed by hostname — `github.com` in `hosts.json`, and
 * `github.com:<oauth app id>` in `apps.json` — with `oauth_token` beside the
 * login. The app id varies by extension build, so the key is matched on its
 * hostname prefix rather than spelled out.
 */
export function readTokenFromCredentialFile(text: string): string | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asRecord(document);
  if (root === null) return null;
  for (const [key, value] of Object.entries(root)) {
    if (key !== HOSTNAME && !key.startsWith(`${HOSTNAME}:`)) continue;
    const entry = asRecord(value);
    const token = entry?.oauth_token;
    if (typeof token === "string" && token !== "") return token;
  }
  return null;
}

export interface ResolvedCopilotToken {
  token: string;
  /** Where it came from, safe to print: an env variable name or a file path. */
  origin: string;
}

export function resolveCopilotToken(
  adapters: Pick<GithubCopilotProbeAdapters, "env" | "homeDir" | "readTextFile">,
): ResolvedCopilotToken {
  const fromEnv = adapters.env[TOKEN_ENV_VARIABLE];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { token: fromEnv.trim(), origin: `env ${TOKEN_ENV_VARIABLE}` };
  }
  const tried: string[] = [`${TOKEN_ENV_VARIABLE} (not set)`];
  const directory = copilotConfigDir(adapters);
  for (const name of CREDENTIAL_FILES) {
    const path = join(directory, name);
    const text = adapters.readTextFile(path);
    if (text === null) {
      tried.push(`${path} (no such file)`);
      continue;
    }
    const token = readTokenFromCredentialFile(text);
    if (token === null) {
      tried.push(`${path} (no ${HOSTNAME} token stored)`);
      continue;
    }
    return { token, origin: `file ${path}` };
  }
  throw new GithubCopilotProbeError(
    `no Copilot token was found; sign in with the Copilot extension, or set ${TOKEN_ENV_VARIABLE}. Tried ${tried.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * Maps the `copilot_internal/user` payload onto the fixed bucket list. The
 * service reports an entitlement with what is left and a percentage left;
 * `quota_reset_date` is a calendar day, kept as the string it arrives as.
 */
export function mapCopilotUser(
  document: unknown,
  source: string,
  fetchedAt: string,
): GithubCopilotQuota {
  const root = asRecord(document);
  const snapshots = asRecord(root?.quota_snapshots);
  const plan =
    typeof root?.copilot_plan === "string" && root.copilot_plan !== "" ? root.copilot_plan : null;
  const resetRaw = root?.quota_reset_date;
  const resetsAt =
    typeof resetRaw === "string" && !Number.isNaN(Date.parse(resetRaw)) ? resetRaw : null;

  const buckets = KNOWN_BUCKETS.map(({ id, key, label }) => {
    const snapshot = asRecord(snapshots?.[key]);
    const unlimited = snapshot?.unlimited === true;
    return {
      id,
      label,
      entitlement: snapshot === null ? null : finiteNumber(snapshot.entitlement),
      remaining: snapshot === null ? null : finiteNumber(snapshot.remaining),
      percentRemaining: snapshot === null ? null : finiteNumber(snapshot.percent_remaining),
      metered: snapshot !== null && !unlimited,
      unlimited,
      resetsAt,
    };
  });

  return { source, fetchedAt, plan, resetsAt, buckets };
}

export async function probeGithubCopilotQuota(
  adapters: GithubCopilotProbeAdapters = createNodeGithubCopilotProbeAdapters(),
): Promise<GithubCopilotQuota> {
  const resolved = resolveCopilotToken(adapters);
  let result: { status: number; document: unknown };
  try {
    result = await adapters.fetchJson(USER_ENDPOINT, {
      ...EXTENSION_HEADERS,
      Authorization: `token ${resolved.token}`,
    });
  } catch (error) {
    throw new GithubCopilotProbeError(
      `could not reach the Copilot endpoint: ${error instanceof Error ? error.message : "error"}`,
      { cause: error },
    );
  }
  if (result.status === 401 || result.status === 403) {
    throw new GithubCopilotProbeError(
      `GitHub rejected the Copilot token from ${resolved.origin} (HTTP ${result.status}); sign in with the Copilot extension again`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new GithubCopilotProbeError(`the Copilot endpoint returned HTTP ${result.status}`);
  }
  if (result.document === null) {
    throw new GithubCopilotProbeError("the Copilot endpoint did not return JSON");
  }
  return mapCopilotUser(result.document, resolved.origin, adapters.now().toISOString());
}

// ---------------------------------------------------------------------------
// Direct execution: a `command` source runs this and reads stdout
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await probeGithubCopilotQuota(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void main();
}
