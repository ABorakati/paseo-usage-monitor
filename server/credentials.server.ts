import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageCredentialMissingError, UsageInterpolationError } from "./errors.server";
import { interpolate } from "./interpolate.server";
import { readStringAtPath, readTimestampAtPath } from "./json-path.server";
import type { UsageCredentials, UsageCredentialSource } from "../shared/limits.shared";

/**
 * Resolves the secrets a provider's source template refers to. A credential
 * names an ordered chain of places to look — an environment variable, then a
 * vendor's own token file — and the first one that produces a non-empty value
 * wins. A source that cannot be read is skipped, not fatal: users have one
 * vendor authenticated by CLI login and another by exported key.
 *
 * A stored token also carries its own deadline. The agent CLIs own refresh, so
 * a file this plugin only reads goes stale the moment its CLI stops running —
 * Claude Code's credential sat 34 hours past expiry while the card showed a
 * bare transport error. An expired source therefore does not resolve, the
 * chain moves on, and the failure says which source expired and how long ago.
 *
 * Nothing here ever puts a resolved value in an error, so a failure names
 * every place that was tried and none of what was found. `redact` closes the
 * other direction: a vendor that echoes a rejected token back in its response
 * would otherwise carry it into a provider error and onto the screen.
 */

type UsageJsonFileCredential = Extract<UsageCredentialSource, { kind: "jsonFile" }>;

type UsageKeychainCredential = Extract<UsageCredentialSource, { kind: "keychain" }>;

type UsageOmpCredential = Extract<UsageCredentialSource, { kind: "omp" }>;

/** The fields a json-bearing source shares, whether the json came from a file or a Keychain item. */
type UsageJsonCredential = Pick<UsageJsonFileCredential, "path" | "expiresAtPath">;

export interface CredentialAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
  /**
   * The macOS Keychain, absent on every other host. A `keychain` source on a
   * host without one is skipped like a file that is not there, and the
   * failure says so rather than hinting at an item that could never exist.
   */
  readKeychainItem?: (service: string) => string | null;
  /**
   * The `data` json of the first enabled row omp stores for a provider, or
   * null when omp is not installed, has no vault, or has no row for it.
   */
  readOmpCredential?: (provider: string) => string | null;
  now(): Date;
}

export function createNodeCredentialAdapters(): CredentialAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    now(): Date {
      return new Date();
    },
    readTextFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // A credential file that is absent, unreadable, or a directory means
        // this source does not apply, which the chain handles by moving on.
        return null;
      }
    },
    readKeychainItem: process.platform === "darwin" ? readMacKeychainItem : undefined,
    readOmpCredential(provider: string): string | null {
      return readOmpVaultRow(ompAgentDbPath(process.env, homedir()), provider);
    },
  };
}

/** omp's agent directory, mirroring its own `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` rules. */
export function ompAgentDbPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const agentDir =
    env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR !== ""
      ? env.PI_CODING_AGENT_DIR
      : join(homeDir, env.PI_CONFIG_DIR ?? ".omp", "agent");
  return join(agentDir, "agent.db");
}

function readOmpVaultRow(dbPath: string, provider: string): string | null {
  if (!existsSync(dbPath)) return null;
  // the provider id is schema-validated to [a-z0-9._-], so quoting it is
  // enough; the CLI has no parameter binding to lean on
  const sql = `SELECT data FROM auth_credentials WHERE provider = '${provider}' AND disabled_cause IS NULL ORDER BY id ASC LIMIT 1;`;
  let out: string;
  try {
    out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    // no sqlite3 on PATH, a locked database, or a vault older than the
    // auth_credentials table all mean this source does not apply
    return null;
  }
  const rows = parseJsonDocument(out.trim() === "" ? "[]" : out);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const data = (rows[0] as { data?: unknown }).data;
  return typeof data === "string" ? data : null;
}

function readMacKeychainItem(service: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    // `security` exits non-zero when no item matches or the Keychain is
    // locked, and either way this source does not apply.
    return null;
  }
}

export function expandPath(raw: string, adapters: CredentialAdapters): string {
  const expanded = interpolate(raw, function readEnvironment(name: string): string {
    const value = adapters.env[name];
    if (value === undefined || value === "") {
      throw new UsageInterpolationError(raw, name);
    }
    return value;
  });
  if (expanded === "~") return adapters.homeDir;
  if (expanded.startsWith("~/")) return `${adapters.homeDir}${expanded.slice(1)}`;
  return expanded;
}

/**
 * Why a source did not hand over a token, because "expired" and "not there"
 * need different fixes: one wants the vendor's CLI run again, the other wants
 * a login or an exported key.
 */
type SourceRead =
  | { kind: "resolved"; token: string }
  | { kind: "unavailable" }
  /** A Keychain source on a host that has no Keychain. */
  | { kind: "unsupported" }
  /** The path could not be built because its variable is not set. */
  | { kind: "unset"; variable: string }
  /** The place exists and holds nothing: signed out, not misconfigured. */
  | { kind: "empty" }
  | { kind: "expired"; ageMs: number };

const UNAVAILABLE: SourceRead = { kind: "unavailable" };

const EMPTY: SourceRead = { kind: "empty" };

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

function formatAge(ageMs: number): string {
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)}m`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h`;
  return `${Math.floor(ageMs / DAY_MS)}d`;
}

function describePlace(source: UsageCredentialSource): string {
  switch (source.kind) {
    case "env":
      return `env ${source.variable}`;
    case "jsonFile":
      return `file ${source.file}#${source.path}`;
    case "keychain":
      return `keychain "${source.service}"#${source.path}`;
    case "omp":
      return `omp "${source.provider}"#${source.path}`;
  }
}

function describeSource(source: UsageCredentialSource, read: SourceRead): string {
  const place = describePlace(source);
  if (read.kind === "expired") return `${place} (expired ${formatAge(read.ageMs)} ago)`;
  if (read.kind === "unsupported") return `${place} (no Keychain on this host)`;
  // A path built from an unset variable never existed, so saying only that the
  // file did not resolve would send the user looking for a file.
  if (read.kind === "unset") return `${place} (${read.variable} is not set)`;
  // A file that exists and holds an empty token means signed out, which is a
  // different fix from a file that is not there at all.
  if (read.kind === "empty") return `${place} (no token stored)`;
  return place;
}

function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * An `expiresAtPath` that resolves to no usable timestamp means no expiry: a
 * vendor whose file omits the field, or spells it a way this cannot read, must
 * not be locked out of a token that still works.
 */
function readExpiredAge(
  source: UsageJsonCredential,
  document: unknown,
  adapters: CredentialAdapters,
): number | null {
  if (source.expiresAtPath === undefined) return null;
  const timestamp = readTimestampAtPath(document, source.expiresAtPath);
  if (timestamp === null) return null;
  const expiresAtMs = Date.parse(timestamp);
  if (Number.isNaN(expiresAtMs)) return null;
  const ageMs = adapters.now().getTime() - expiresAtMs;
  return ageMs >= 0 ? ageMs : null;
}

function readJsonCredential(
  source: UsageJsonCredential,
  text: string,
  adapters: CredentialAdapters,
): SourceRead {
  const document = parseJsonDocument(text);
  const value = readStringAtPath(document, source.path);
  if (value === null) return UNAVAILABLE;
  const token = value.trim();
  if (token === "") return EMPTY;
  const ageMs = readExpiredAge(source, document, adapters);
  if (ageMs !== null) return { kind: "expired", ageMs };
  return { kind: "resolved", token };
}

function readJsonFileCredential(
  source: UsageJsonFileCredential,
  adapters: CredentialAdapters,
): SourceRead {
  const expanded = expandCredentialPath(source.file, adapters);
  if (expanded.kind === "unset") return expanded;
  const text = adapters.readTextFile(expanded.path);
  if (text === null) return UNAVAILABLE;
  return readJsonCredential(source, text, adapters);
}

function readKeychainCredential(
  source: UsageKeychainCredential,
  adapters: CredentialAdapters,
): SourceRead {
  if (adapters.readKeychainItem === undefined) return { kind: "unsupported" };
  const text = adapters.readKeychainItem(source.service);
  if (text === null) return UNAVAILABLE;
  return readJsonCredential(source, text, adapters);
}

function readOmpCredential(source: UsageOmpCredential, adapters: CredentialAdapters): SourceRead {
  const text = adapters.readOmpCredential?.(source.provider) ?? null;
  if (text === null) return UNAVAILABLE;
  return readJsonCredential(source, text, adapters);
}

function expandCredentialPath(
  raw: string,
  adapters: CredentialAdapters,
): { kind: "path"; path: string } | { kind: "unset"; variable: string } {
  try {
    return { kind: "path", path: expandPath(raw, adapters) };
  } catch (error) {
    // The variable name is the whole message: it is the difference between
    // "your file is missing" and "you never set this variable".
    if (error instanceof UsageInterpolationError) {
      return { kind: "unset", variable: error.variable };
    }
    throw error;
  }
}

function readSource(source: UsageCredentialSource, adapters: CredentialAdapters): SourceRead {
  if (source.kind === "jsonFile") return readJsonFileCredential(source, adapters);
  if (source.kind === "keychain") return readKeychainCredential(source, adapters);
  if (source.kind === "omp") return readOmpCredential(source, adapters);
  const value = adapters.env[source.variable];
  if (value === undefined) return UNAVAILABLE;
  const token = value.trim();
  if (token === "") return EMPTY;
  return { kind: "resolved", token };
}

const REDACTION_MIN_LENGTH = 8;

const REDACTED = "<redacted>";

export interface UsageCredentialResolver {
  resolve(name: string): string;
  /**
   * Replaces every value this resolver has handed out with "<redacted>".
   * Longest first, so a value containing another is not partially replaced.
   */
  redact(text: string): string;
}

export function createCredentialResolver(
  credentials: UsageCredentials,
  adapters: CredentialAdapters,
): UsageCredentialResolver {
  const resolved = new Map<string, string>();
  const secrets = new Set<string>();

  function resolve(name: string): string {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    const tried: string[] = [];
    for (const source of credentials[name] ?? []) {
      const read = readSource(source, adapters);
      tried.push(describeSource(source, read));
      if (read.kind === "resolved") {
        resolved.set(name, read.token);
        if (read.token.length >= REDACTION_MIN_LENGTH) secrets.add(read.token);
        return read.token;
      }
    }
    throw new UsageCredentialMissingError(name, tried);
  }

  function redact(text: string): string {
    const longestFirst = [...secrets].sort((left, right) => right.length - left.length);
    let scrubbed = text;
    for (const secret of longestFirst) {
      scrubbed = scrubbed.replaceAll(secret, REDACTED);
    }
    return scrubbed;
  }

  return { resolve, redact };
}
