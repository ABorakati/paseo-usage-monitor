import {
  createCredentialResolver,
  type CredentialAdapters,
  type UsageCredentialResolver,
} from "./credentials.server";
import {
  UsageConfigError,
  UsageCredentialMissingError,
  UsageRateLimitedError,
  UsageSourceError,
  UsageVendorError,
} from "./errors.server";
import { interpolateSource } from "./interpolate.server";
import { readAtPath, readNumberAtPath, readStringAtPath } from "./json-path.server";
import type {
  UsageCredentials,
  UsageHttpFailure,
  UsageProvider,
  UsageProviderSnapshot,
  UsageSnapshot,
} from "./limits.shared";
import { projectReadings, requiresSourceDocument } from "./readings.server";
import { fetchSourceDocument, type UsageSourceAdapters } from "./source.server";
import type { UsageProviderEntry } from "./registry.server";
import type { ReadingStore, StoredReading } from "./reading-store.server";

export interface UsageServiceAdapters {
  source: UsageSourceAdapters;
  credentials: CredentialAdapters;
  now(): Date;
  /**
   * Always injected, never defaulted: a store the service builds itself would
   * resolve a real home directory, and a caller that forgot one would write
   * live readings somewhere nobody asked for.
   */
  readings: ReadingStore;
}

export interface UsageServiceInput {
  entries: readonly UsageProviderEntry[];
  configPath: string;
  adapters: UsageServiceAdapters;
}

export interface UsageService {
  read(options: { refresh: boolean }): Promise<UsageSnapshot>;
}

interface CacheEntry {
  snapshot: UsageProviderSnapshot;
  expiresAt: number;
}

/**
 * A provider that answered 429. The endpoint is a seed, not a polling target,
 * so the service stops asking until `retryAtMs` and keeps the last readings on
 * screen. `attempts` escalates the wait only when the vendor sent no
 * `Retry-After`, and resets the moment a request succeeds.
 */
interface BackoffState {
  retryAtMs: number;
  attempts: number;
  message: string;
}

const FIRST_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function escalatedBackoffMs(attempts: number): number {
  return Math.min(FIRST_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/**
 * A rejected credential, told apart from every other transport failure. The
 * status is recovered from the message the http adapter formats, because
 * `UsageSourceError` carries no status field and neither it nor the adapter
 * belongs to this file; a status field on the error would be exact and this is
 * the approximation until one exists. Only 401 and 403 count: every other
 * status says something about the endpoint, not about the token.
 */
const AUTH_FAILURE_PATTERN = /\bfailed with HTTP (401|403)\b/;

function authFailureStatus(error: unknown): string | null {
  if (!(error instanceof UsageSourceError)) return null;
  return AUTH_FAILURE_PATTERN.exec(error.message)?.[1] ?? null;
}

/**
 * What the user can actually do about a rejected credential. A token in a file
 * this plugin only reads cannot be refreshed from here — the agent CLI that
 * wrote the file owns refresh, and minting a token from its stored refresh
 * token would risk invalidating the CLI's own session — so the remedy names
 * that file and asks for its CLI to run. A source may declare `refreshedBy`,
 * and then the sentence names that command instead of leaving the user to guess
 * a binary; without it the wording stays generic rather than inventing one.
 * Nothing here names a credential value, only where one lives.
 */
/**
 * A key the user pasted into the plugin's own editor lives in this file, and no
 * CLI refreshes it, so its remedy is to paste a new one rather than to run
 * something.
 */
const SECRETS_FILE_NAME = "usage-limits.secrets.json";

/**
 * A path that still carries a `${VAR}` was never expanded, which means that
 * variable is unset and is exactly why the source failed. Naming it in the
 * remedy would send the user to a file that does not exist, so the chain is
 * walked past it to one whose path is real.
 */
function isUnexpanded(file: string): boolean {
  return file.includes("${");
}

function credentialRemedy(credentials: UsageCredentials): string {
  let variable: string | null = null;
  for (const source of Object.values(credentials).flat()) {
    if (source.kind !== "jsonFile") {
      variable ??= source.variable;
      continue;
    }
    if (source.file.endsWith(SECRETS_FILE_NAME)) {
      return "Replace the stored key from the Usage providers screen.";
    }
    if (isUnexpanded(source.file)) continue;
    if (source.refreshedBy !== undefined) {
      return `Run \`${source.refreshedBy}\` so it refreshes ${source.file}.`;
    }
    return `Run the CLI that owns ${source.file} so it refreshes the stored token.`;
  }
  if (variable !== null) return `Set a current token in ${variable}.`;
  return "Re-authenticate this provider.";
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
];

function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * A persisted reading can be from a previous day, so the date is only dropped
 * when it would tell the reader nothing.
 */
function formatReadingTime(fetchedAt: string, now: Date): string {
  const date = new Date(fetchedAt);
  const clock = formatClock(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return clock;
  return `${date.getDate()} ${MONTH_LABELS[date.getMonth()] ?? ""} ${clock}`;
}

/**
 * A numeric `equals` also matches a numeric string, the same coercion every
 * amount path applies; a string or boolean must match exactly, and a path that
 * does not resolve never matches, so an envelope the vendor stops sending
 * cannot read as a refusal.
 */
function vendorRefused(document: unknown, failure: UsageHttpFailure): boolean {
  if (typeof failure.equals === "number") {
    return readNumberAtPath(document, failure.path) === failure.equals;
  }
  return readAtPath(document, failure.path) === failure.equals;
}

function throwIfVendorRefused(document: unknown, failure: UsageHttpFailure | undefined): void {
  if (failure === undefined || !vendorRefused(document, failure)) return;
  const message =
    failure.messagePath === undefined ? null : readStringAtPath(document, failure.messagePath);
  throw new UsageVendorError(
    message === null || message.trim() === "" ? null : message.trim(),
    failure.hint ?? null,
  );
}

function baseSnapshot(id: string, provider: UsageProvider): UsageProviderSnapshot {
  return {
    providerId: id,
    label: provider.label,
    description: provider.description ?? null,
    unverified: provider.unverified,
    status: "ok",
    readings: [],
    error: null,
    notice: null,
    fetchedAt: null,
    display: provider.display,
    icon: provider.display.icon ?? provider.icon ?? null,
  };
}

/**
 * A quota is only true until its window turns over: a snapshot taken a minute
 * before a five-hour window resets describes a window that no longer exists.
 * The earliest reset still ahead of us therefore caps how long the snapshot may
 * be served. A reset already behind us is ignored, so a vendor that keeps
 * reporting a stale timestamp cannot drive a refetch on every read.
 */
function earliestFutureReset(snapshot: UsageProviderSnapshot, fetchedAtMs: number): number | null {
  let earliest: number | null = null;
  for (const reading of snapshot.readings) {
    if (reading.kind !== "quota" || reading.window === null) continue;
    const resetsAt = reading.window.resetsAt;
    if (resetsAt === null) continue;
    const resetsAtMs = Date.parse(resetsAt);
    if (Number.isNaN(resetsAtMs) || resetsAtMs <= fetchedAtMs) continue;
    if (earliest === null || resetsAtMs < earliest) earliest = resetsAtMs;
  }
  return earliest;
}

export function createUsageService(input: UsageServiceInput): UsageService {
  const { entries, configPath, adapters } = input;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<UsageProviderSnapshot>>();
  const backoff = new Map<string, BackoffState>();
  const store = adapters.readings;

  async function readDocument(
    id: string,
    provider: UsageProvider,
    resolver: UsageCredentialResolver,
  ): Promise<unknown> {
    if (!requiresSourceDocument(provider.readings)) return undefined;
    if (!provider.source) {
      throw new UsageConfigError(
        `Usage provider "${id}" reads from a response but declares no source`,
      );
    }
    const interpolated = interpolateSource(provider.source, (name) => resolver.resolve(name));
    const document = await fetchSourceDocument(interpolated, adapters.source, adapters.credentials);
    if (provider.source.kind === "http") throwIfVendorRefused(document, provider.source.failure);
    return document;
  }

  /**
   * The vendor answered and said no in the body. The transport worked and the
   * key was accepted, so neither of those sentences fits; the vendor's words
   * are quoted, the preset's hint follows, and stored readings stay on screen
   * as they do for every other refusal.
   */
  function vendorRefusedSnapshot(
    id: string,
    provider: UsageProvider,
    error: UsageVendorError,
    now: Date,
  ): UsageProviderSnapshot {
    const sentence = error.hint === null ? `${error.message}.` : `${error.message}. ${error.hint}`;
    const stored = storedFallback(id);
    if (!stored) {
      return {
        ...baseSnapshot(id, provider),
        status: "error",
        error: sentence,
        fetchedAt: now.toISOString(),
      };
    }
    const reading = formatReadingTime(stored.fetchedAt, now);
    return storedSnapshot(id, provider, stored, `${sentence} Showing the reading from ${reading}.`);
  }

  /**
   * A stored reading with no readings in it is no fallback. A vendor envelope
   * that projected to nothing was once saved as a good reading, and offering
   * it back as "the reading from 10:18" names a moment that showed nothing.
   */
  function storedFallback(id: string): StoredReading | null {
    const stored = store.get(id);
    return stored !== null && stored.readings.length > 0 ? stored : null;
  }

  function storedSnapshot(
    id: string,
    provider: UsageProvider,
    stored: StoredReading,
    notice: string,
  ): UsageProviderSnapshot {
    return {
      ...baseSnapshot(id, provider),
      readings: stored.readings,
      fetchedAt: stored.fetchedAt,
      notice,
    };
  }

  function rateLimitedSnapshot(
    id: string,
    provider: UsageProvider,
    state: BackoffState,
    now: Date,
  ): UsageProviderSnapshot {
    const retryAt = formatClock(new Date(state.retryAtMs));
    const stored = storedFallback(id);
    if (!stored) {
      return {
        ...baseSnapshot(id, provider),
        status: "error",
        error: `Rate limited by the provider, and no earlier reading is stored yet. Retrying at ${retryAt}.`,
      };
    }
    const reading = formatReadingTime(stored.fetchedAt, now);
    return storedSnapshot(
      id,
      provider,
      stored,
      `Rate limited by the provider. Showing the reading from ${reading} and retrying at ${retryAt}.`,
    );
  }

  function registerRateLimit(
    id: string,
    provider: UsageProvider,
    error: UsageRateLimitedError,
    now: Date,
  ): UsageProviderSnapshot {
    const attempts = (backoff.get(id)?.attempts ?? 0) + 1;
    const wait = error.retryAfterMs ?? escalatedBackoffMs(attempts);
    const state = { retryAtMs: now.getTime() + wait, attempts, message: error.message };
    backoff.set(id, state);
    return rateLimitedSnapshot(id, provider, state, now);
  }

  /**
   * A 401 or 403 is not a transport problem the user can wait out, so the raw
   * status never becomes the headline: the sentence names the remedy, and the
   * stored readings stay on screen exactly as they do while rate limited.
   */
  function authRejectedSnapshot(
    id: string,
    provider: UsageProvider,
    status: string,
    now: Date,
  ): UsageProviderSnapshot {
    const remedy = credentialRemedy(provider.credentials);
    const stored = storedFallback(id);
    if (!stored) {
      return {
        ...baseSnapshot(id, provider),
        status: "error",
        error: `The stored credential was rejected (HTTP ${status}), and no earlier reading is stored yet. ${remedy}`,
        fetchedAt: now.toISOString(),
      };
    }
    const reading = formatReadingTime(stored.fetchedAt, now);
    return storedSnapshot(
      id,
      provider,
      stored,
      `The stored credential was rejected (HTTP ${status}). ${remedy} Showing the reading from ${reading}.`,
    );
  }

  async function loadProvider(id: string, provider: UsageProvider): Promise<UsageProviderSnapshot> {
    const timestamp = adapters.now();
    const resolver = createCredentialResolver(provider.credentials, adapters.credentials);
    try {
      const document = await readDocument(id, provider, resolver);
      const snapshot = {
        ...baseSnapshot(id, provider),
        readings: projectReadings({ readings: provider.readings, document, now: timestamp }),
        fetchedAt: timestamp.toISOString(),
      };
      backoff.delete(id);
      store.save(id, { readings: snapshot.readings, fetchedAt: snapshot.fetchedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof UsageRateLimitedError) {
        return registerRateLimit(id, provider, error, timestamp);
      }
      if (error instanceof UsageVendorError) {
        return vendorRefusedSnapshot(id, provider, error, timestamp);
      }
      const authStatus = authFailureStatus(error);
      if (authStatus !== null) return authRejectedSnapshot(id, provider, authStatus, timestamp);
      const detail = resolver.redact(error instanceof Error ? error.message : String(error));
      const credentialFailure = error instanceof UsageCredentialMissingError;
      const message = credentialFailure
        ? `${detail}. ${credentialRemedy(provider.credentials)}`
        : detail;
      const stored = storedFallback(id);
      if (stored) {
        const reading = formatReadingTime(stored.fetchedAt, timestamp);
        // A credential that did not resolve is not an unreachable host: leading
        // with "could not reach" names a cause that did not happen. The remedy
        // ends its own sentence, so no second full stop is added after it.
        const lead = credentialFailure ? message : `Could not reach the provider: ${detail}.`;
        return storedSnapshot(id, provider, stored, `${lead} Showing the reading from ${reading}.`);
      }
      return {
        ...baseSnapshot(id, provider),
        status: "error",
        error: message,
        fetchedAt: timestamp.toISOString(),
      };
    }
  }

  function cachedProvider(
    id: string,
    provider: UsageProvider,
    refresh: boolean,
  ): Promise<UsageProviderSnapshot> {
    const state = backoff.get(id);
    if (state && adapters.now().getTime() < state.retryAtMs) {
      // A manual refresh during a backoff must not re-trigger the 429.
      return Promise.resolve(rateLimitedSnapshot(id, provider, state, adapters.now()));
    }
    const cached = cache.get(id);
    if (!refresh && cached && cached.expiresAt > adapters.now().getTime()) {
      return Promise.resolve(cached.snapshot);
    }
    const existing = inFlight.get(id);
    if (existing) return existing;

    const request = loadProvider(id, provider)
      .then((snapshot) => {
        if (snapshot.notice !== null) return snapshot;
        const completedAtMs = adapters.now().getTime();
        const interval = completedAtMs + provider.refreshIntervalMs;
        const reset = earliestFutureReset(snapshot, completedAtMs);
        cache.set(id, {
          snapshot,
          expiresAt: reset === null ? interval : Math.min(interval, reset),
        });
        return snapshot;
      })
      .finally(() => {
        if (inFlight.get(id) === request) inFlight.delete(id);
      });
    inFlight.set(id, request);
    return request;
  }

  function entrySnapshot(
    entry: UsageProviderEntry,
    refresh: boolean,
  ): Promise<UsageProviderSnapshot> {
    if (!entry.provider) {
      return Promise.resolve({
        providerId: entry.id,
        label: entry.id,
        description: null,
        unverified: false,
        status: "error",
        readings: [],
        error: entry.error,
        notice: null,
        fetchedAt: null,
        display: {},
        icon: null,
      });
    }
    if (!entry.provider.enabled) {
      return Promise.resolve({ ...baseSnapshot(entry.id, entry.provider), status: "disabled" });
    }
    return cachedProvider(entry.id, entry.provider, refresh);
  }

  return {
    async read(options) {
      const providers = await Promise.all(
        entries.map((entry) => entrySnapshot(entry, options.refresh)),
      );
      return { configPath, providers };
    },
  };
}
