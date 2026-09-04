import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeAntigravityUsage } from "./antigravity-usage.server";
import { type CredentialAdapters, expandPath } from "./credentials.server";
import { probeGithubCopilotQuota } from "./github-copilot-probe.server";
import { UsageInterpolationError, UsageRateLimitedError, UsageSourceError } from "./errors.server";
import type { UsageSource } from "./limits.shared";

type UsageProbeName = Extract<UsageSource, { kind: "probe" }>["probe"];
type UsageFileSource = Extract<UsageSource, { kind: "file" }>;

const REQUEST_TIMEOUT_MS = 15_000;
const STDOUT_LIMIT = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export interface UsageHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * The seam every test injects. A source has already had its credentials
 * interpolated by the time it reaches an adapter, so nothing here may name a
 * url's query, a header, an argv element, a request body or a response body in
 * an error or a log: a vendor that echoes a rejected token back would
 * otherwise carry it into the snapshot and onto the screen.
 */
export interface UsageSourceAdapters {
  fetchJson(request: UsageHttpRequest): Promise<unknown>;
  runCommand(command: readonly string[], cwd: string | undefined): Promise<unknown>;
  /**
   * A probe reads a vendor's quota through a mechanism no url can express, so
   * it arrives as an injected function rather than as config. Optional so a
   * caller that never configures a probe source needs no stub; a probe source
   * reaching an adapter without one fails as that provider's error, loudly.
   */
  probeAntigravity?: () => Promise<unknown>;
  probeGithubCopilot?: () => Promise<unknown>;
}

function describeRequest(request: UsageHttpRequest): string {
  try {
    return `${request.method} request to ${new URL(request.url).host}`;
  } catch {
    return `${request.method} request to the configured endpoint`;
  }
}

function parseJsonDocument(raw: string, origin: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageSourceError(`${origin} did not return JSON`);
  }
}

/**
 * `Retry-After` is either a count of seconds or an HTTP date. Anthropic sends
 * seconds (1495 when observed live) and it is worth honouring exactly, but a
 * value that is zero, backwards, unparseable or longer than six hours says more
 * about the vendor's clock than about when to come back, so the service falls
 * back to its own escalation instead.
 */
function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  const milliseconds = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMs;
  if (Number.isNaN(milliseconds)) return null;
  if (milliseconds <= 0 || milliseconds > MAX_RETRY_AFTER_MS) return null;
  return milliseconds;
}

async function sendRequest(request: UsageHttpRequest, origin: string): Promise<Response> {
  try {
    return await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch reports the whole url, which can carry an interpolated credential.
    throw new UsageSourceError(`${origin} failed`, { cause: error });
  }
}

async function fetchJsonWithNode(request: UsageHttpRequest): Promise<unknown> {
  const origin = describeRequest(request);
  const response = await sendRequest(request, origin);
  const body = await response.text();
  if (response.status === 429) {
    throw new UsageRateLimitedError(
      `${origin} failed with HTTP 429`,
      parseRetryAfter(response.headers.get("retry-after"), Date.now()),
    );
  }
  if (!response.ok) {
    throw new UsageSourceError(`${origin} failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return parseJsonDocument(body, origin);
}

const execFileAsync = promisify(execFile);

/**
 * Node kills the child for both a timeout and a `maxBuffer` overflow, so the
 * `killed` flag alone cannot tell them apart; only the overflow carries a code.
 */
function describeExecFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "failed";
  if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `printed more than ${STDOUT_LIMIT} bytes`;
  }
  if ("killed" in error && error.killed === true) {
    return `timed out after ${REQUEST_TIMEOUT_MS}ms`;
  }
  return "failed";
}

async function execFileStdout(
  binary: string,
  args: readonly string[],
  cwd: string | undefined,
): Promise<string> {
  try {
    const result = await execFileAsync(binary, [...args], {
      cwd,
      timeout: REQUEST_TIMEOUT_MS,
      shell: false,
      env: process.env,
      maxBuffer: STDOUT_LIMIT,
    });
    return result.stdout;
  } catch (error) {
    // The exec error repeats the full argv and stdout, which can carry a credential.
    throw new UsageSourceError(`Command "${binary}" ${describeExecFailure(error)}`);
  }
}

async function runCommandWithNode(
  command: readonly string[],
  cwd: string | undefined,
): Promise<unknown> {
  const [binary, ...args] = command;
  if (binary === undefined) throw new UsageSourceError("Command source declares an empty argv");
  const stdout = await execFileStdout(binary, args, cwd);
  return parseJsonDocument(stdout, `Command "${binary}"`);
}

export function createNodeSourceAdapters(): UsageSourceAdapters {
  return {
    fetchJson: fetchJsonWithNode,
    runCommand: runCommandWithNode,
    probeAntigravity: probeAntigravityUsage,
    probeGithubCopilot: () => probeGithubCopilotQuota(),
  };
}

const PROBE_LABELS: Record<UsageProbeName, string> = {
  antigravity: "Antigravity",
  "github-copilot": "GitHub Copilot",
};

function probeAdapter(
  probe: UsageProbeName,
  adapters: UsageSourceAdapters,
): (() => Promise<unknown>) | undefined {
  if (probe === "antigravity") return adapters.probeAntigravity;
  return adapters.probeGithubCopilot;
}

async function runProbe(probe: UsageProbeName, adapters: UsageSourceAdapters): Promise<unknown> {
  const label = PROBE_LABELS[probe];
  const run = probeAdapter(probe, adapters);
  if (!run) {
    throw new UsageSourceError(`${label} probe failed: no probe is available to this caller`);
  }
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageSourceError(`${label} probe failed: ${reason}`, { cause: error });
  }
}

/**
 * Reads the first candidate path that holds a JSON document. Every candidate
 * that did not answer is named with why, because the two reasons want opposite
 * fixes: an unset variable means the override this path assumes is not in use,
 * and an absent file means whatever writes it has not run.
 *
 * A path is not a secret, so unlike a request it may appear in the message.
 */
function readFileDocument(source: UsageFileSource, machine: CredentialAdapters): unknown {
  const tried: string[] = [];
  for (const candidate of source.files) {
    let path: string;
    try {
      path = expandPath(candidate, machine);
    } catch (error) {
      if (!(error instanceof UsageInterpolationError)) throw error;
      tried.push(`${candidate} (${error.variable} is not set)`);
      continue;
    }
    const text = machine.readTextFile(path);
    if (text === null) {
      tried.push(`${path} (no such file)`);
      continue;
    }
    return parseJsonDocument(text, `File ${path}`);
  }
  throw new UsageSourceError(`No usage file was readable: ${tried.join(", ")}`);
}

/**
 * `async` so every kind fails the same way. A local read is the one branch that
 * can fail before any promise exists, and a caller that awaits the others would
 * not survive a synchronous throw from this one.
 */
export async function fetchSourceDocument(
  source: UsageSource,
  adapters: UsageSourceAdapters,
  machine: CredentialAdapters,
): Promise<unknown> {
  if (source.kind === "http") {
    return adapters.fetchJson({
      url: source.url,
      method: source.method,
      headers: source.headers,
      body: source.body,
    });
  }
  if (source.kind === "command") {
    return adapters.runCommand(source.command, source.cwd);
  }
  if (source.kind === "file") {
    // Reading a local file needs no adapter of its own: the machine adapters
    // already carry the environment, the home directory and the file read that
    // a `jsonFile` credential resolves through, and a stub for one is a stub
    // for both.
    return readFileDocument(source, machine);
  }
  return runProbe(source.probe, adapters);
}
