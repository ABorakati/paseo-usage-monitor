import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { UsageCredentialMissingError, UsageInterpolationError } from "./errors.server";
import { interpolate } from "./interpolate.server";
import { readStringAtPath, readTimestampAtPath } from "./json-path.server";
import type { UsageCredentials, UsageCredentialSource } from "./limits.shared";

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

export interface CredentialAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
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
  };
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

function describeSource(source: UsageCredentialSource, read: SourceRead): string {
  const place =
    source.kind === "env" ? `env ${source.variable}` : `file ${source.file}#${source.path}`;
  if (read.kind === "expired") return `${place} (expired ${formatAge(read.ageMs)} ago)`;
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
  source: UsageJsonFileCredential,
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

function readJsonFileCredential(
  source: UsageJsonFileCredential,
  adapters: CredentialAdapters,
): SourceRead {
  const expanded = expandCredentialPath(source.file, adapters);
  if (expanded.kind === "unset") return expanded;
  const text = adapters.readTextFile(expanded.path);
  if (text === null) return UNAVAILABLE;
  const document = parseJsonDocument(text);
  const value = readStringAtPath(document, source.path);
  if (value === null) return UNAVAILABLE;
  const token = value.trim();
  if (token === "") return EMPTY;
  const ageMs = readExpiredAge(source, document, adapters);
  if (ageMs !== null) return { kind: "expired", ageMs };
  return { kind: "resolved", token };
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
