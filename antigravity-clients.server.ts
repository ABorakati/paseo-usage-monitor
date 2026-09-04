/**
 * Reads how much Antigravity its own clients spent on this machine, from the
 * conversation stores the app, the `agy` CLI and the ACP bridge each write.
 *
 * This exists because the vendor's quota route answers for one ledger only.
 * `retrieveUserQuotaSummary` reports the consumer Antigravity plan, so traffic
 * that runs under a user's own Cloud project — which is how Paseo reaches the
 * model — leaves those buckets reading full. A card that only mirrored them
 * would say 0% to somebody who spent the day in Antigravity.
 *
 * Each conversation is a SQLite file whose `steps` table holds one row per turn.
 * A row's `metadata` blob is protobuf with no schema shipped anywhere, so only
 * two fields are read, both confirmed against live data:
 *
 *   field 1  — `Timestamp { 1: seconds, 2: nanos }` for the step.
 *   field 9  — the generation's usage: `2` uncached input, `3` output,
 *              `5` cached input, and `9`/`10` splitting `3`.
 *
 * The split is what makes the reading trustworthy rather than guessed: across
 * 261 live rows, field 3 equalled field 9 plus field 10 every time, which no
 * unrelated pair of counters would do. `verifyStepUsage` keeps that check in
 * the reader, so a schema change surfaces as a dropped row instead of a wrong
 * number.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One model generation as its client recorded it. */
export interface AntigravityStepUsage {
  timestampMs: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface AntigravityClientRows {
  id: string;
  label: string;
  rows: AntigravityStepUsage[];
}

export interface AntigravityClientAdapters {
  homeDir: string;
  /** Conversation store files under one client directory, newest first. */
  listStores(directory: string): string[];
  /** Usage-bearing steps in one store, newest first; empty when unreadable. */
  readStoreSteps(path: string, fromMs: number): AntigravityStepUsage[];
  now(): Date;
}

/**
 * The three stores Antigravity writes, each a separate client with its own
 * quota footprint: the desktop app, the `agy` CLI, and the ACP bridge an
 * external agent drives.
 */
const CLIENT_DIRECTORIES: readonly { id: string; label: string; directory: string }[] = [
  { id: "app", label: "Antigravity app", directory: "antigravity" },
  { id: "cli", label: "Antigravity CLI", directory: "antigravity-cli" },
  { id: "acp", label: "Antigravity ACP", directory: "antigravity-acp" },
];

const GEMINI_HOME_DIRECTORY = ".gemini";
const CONVERSATIONS_DIRECTORY = "conversations";
const STORE_SUFFIX = ".db";

const STEP_TIMESTAMP_FIELD = 1;
const STEP_USAGE_FIELD = 9;
const USAGE_UNCACHED_INPUT_FIELD = 2;
const USAGE_OUTPUT_FIELD = 3;
const USAGE_CACHED_INPUT_FIELD = 5;
const USAGE_OUTPUT_PART_FIELDS = [9, 10] as const;
const TIMESTAMP_SECONDS_FIELD = 1;

/** Sane epoch bounds: 2020-09-13 to 2033-05-18, so a counter never reads as a clock. */
const MIN_PLAUSIBLE_SECONDS = 1_600_000_000;
const MAX_PLAUSIBLE_SECONDS = 2_000_000_000;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

interface ProtoField {
  field: number;
  varint: number | null;
  bytes: Uint8Array | null;
}

/**
 * Walks one protobuf message, one field at a time. A malformed or truncated
 * blob ends the walk rather than throwing: a store being appended to while it
 * is read is normal, and the rows already yielded stay valid.
 */
function* protoFields(bytes: Uint8Array): Generator<ProtoField> {
  let at = 0;
  while (at < bytes.length) {
    let key = 0;
    let shift = 0;
    let byte = 0x80;
    while (at < bytes.length && (byte & 0x80) !== 0) {
      byte = bytes[at++] as number;
      key |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 0) return;
    if (wire === WIRE_VARINT) {
      let value = 0;
      let scale = 1;
      byte = 0x80;
      while (at < bytes.length && (byte & 0x80) !== 0) {
        byte = bytes[at++] as number;
        value += (byte & 0x7f) * scale;
        scale *= 128;
      }
      yield { field, varint: value, bytes: null };
      continue;
    }
    if (wire === WIRE_LENGTH) {
      let length = 0;
      let scale = 1;
      byte = 0x80;
      while (at < bytes.length && (byte & 0x80) !== 0) {
        byte = bytes[at++] as number;
        length += (byte & 0x7f) * scale;
        scale *= 128;
      }
      if (at + length > bytes.length) return;
      yield { field, varint: null, bytes: bytes.subarray(at, at + length) };
      at += length;
      continue;
    }
    if (wire === WIRE_FIXED64) {
      at += 8;
      continue;
    }
    if (wire === WIRE_FIXED32) {
      at += 4;
      continue;
    }
    return;
  }
}

function varintAt(bytes: Uint8Array, target: number): number | null {
  for (const entry of protoFields(bytes)) {
    if (entry.field === target && entry.varint !== null) return entry.varint;
  }
  return null;
}

/**
 * A usage block whose output does not equal its two parts is not the block
 * this reader was written against, so the row is dropped rather than reported.
 * Absent parts are accepted: an empty answer carries neither.
 */
function verifyStepUsage(usage: Uint8Array, outputTokens: number): boolean {
  const parts = USAGE_OUTPUT_PART_FIELDS.map((field) => varintAt(usage, field));
  if (parts.every((part) => part === null)) return true;
  const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return total === outputTokens;
}

/**
 * One step blob to one generation, or null when the row is not a generation
 * (a tool call, a permission prompt) or does not match the verified shape.
 */
export function decodeStepUsage(bytes: Uint8Array): AntigravityStepUsage | null {
  let timestampMs: number | null = null;
  let usage: Uint8Array | null = null;
  for (const entry of protoFields(bytes)) {
    if (entry.bytes === null) continue;
    if (entry.field === STEP_TIMESTAMP_FIELD) {
      const seconds = varintAt(entry.bytes, TIMESTAMP_SECONDS_FIELD);
      if (seconds !== null && seconds >= MIN_PLAUSIBLE_SECONDS && seconds <= MAX_PLAUSIBLE_SECONDS) {
        timestampMs = seconds * 1000;
      }
      continue;
    }
    if (entry.field === STEP_USAGE_FIELD) usage = entry.bytes;
  }
  if (timestampMs === null || usage === null) return null;
  const outputTokens = varintAt(usage, USAGE_OUTPUT_FIELD) ?? 0;
  if (!verifyStepUsage(usage, outputTokens)) return null;
  return {
    timestampMs,
    uncachedInputTokens: varintAt(usage, USAGE_UNCACHED_INPUT_FIELD) ?? 0,
    cachedInputTokens: varintAt(usage, USAGE_CACHED_INPUT_FIELD) ?? 0,
    outputTokens,
  };
}

export function readAntigravityClientRows(
  fromMs: number,
  adapters: AntigravityClientAdapters,
): AntigravityClientRows[] {
  const clients: AntigravityClientRows[] = [];
  for (const client of CLIENT_DIRECTORIES) {
    const directory = join(
      adapters.homeDir,
      GEMINI_HOME_DIRECTORY,
      client.directory,
      CONVERSATIONS_DIRECTORY,
    );
    const rows: AntigravityStepUsage[] = [];
    for (const store of adapters.listStores(directory)) {
      rows.push(...adapters.readStoreSteps(store, fromMs));
    }
    if (rows.length > 0) clients.push({ id: client.id, label: client.label, rows });
  }
  return clients;
}

function listStoresOnDisk(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // A client that was never installed has no directory, which is not a fault.
    return [];
  }
  const stores: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(STORE_SUFFIX)) continue;
    const path = join(directory, entry);
    try {
      stores.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      continue;
    }
  }
  return stores.sort((left, right) => right.mtimeMs - left.mtimeMs).map((store) => store.path);
}

/**
 * Rows come back newest first and the walk stops at the first row older than
 * the window, because `idx` ascends with time. A store the client still holds
 * open reads fine: the connection is read-only and never takes a write lock.
 */
function readStoreStepsOnDisk(path: string, fromMs: number): AntigravityStepUsage[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return [];
  }
  if (mtimeMs < fromMs) return [];
  const rows: AntigravityStepUsage[] = [];
  try {
    const store = new DatabaseSync(path, { readOnly: true });
    try {
      const statement = store.prepare(
        "select metadata from steps where metadata is not null order by idx desc",
      );
      for (const row of statement.all()) {
        const blob = row.metadata;
        if (!(blob instanceof Uint8Array)) continue;
        const step = decodeStepUsage(blob);
        if (step === null) continue;
        if (step.timestampMs < fromMs) break;
        rows.push(step);
      }
    } finally {
      store.close();
    }
  } catch {
    // Not a conversation store, or one this build cannot open. A single
    // unreadable file must not cost the whole reading.
    return rows;
  }
  return rows;
}

export function createNodeAntigravityClientAdapters(): AntigravityClientAdapters {
  return {
    homeDir: homedir(),
    listStores: listStoresOnDisk,
    readStoreSteps: readStoreStepsOnDisk,
    now() {
      return new Date();
    },
  };
}
