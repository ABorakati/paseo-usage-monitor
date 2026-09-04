/**
 * Reads live Antigravity quota — the two shared pools (Gemini models, and the
 * third-party Claude/GPT pool) with their rolling 5-hour and weekly windows.
 *
 * Antigravity publishes no usage API, so this goes through the same private
 * endpoint the product itself uses:
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *   Authorization: Bearer <the user's own Antigravity OAuth access token>
 *
 * The token is the one Antigravity / the `agy` CLI already stored for this
 * machine's login: a Secret Service item (service `gemini`, account
 * `antigravity`) on Linux, the equivalent Keychain generic password on macOS.
 * Nothing here writes to that item.
 *
 * A stored access token lives one hour, so it is usually stale. Refreshing it
 * needs Antigravity's OAuth client id and secret; those are read out of the
 * installed `agy` binary at probe time rather than baked in here, so the plugin
 * carries no vendor secret and follows whatever the user's install ships. The
 * refresh grant returns no new refresh token, so the stored credential is left
 * exactly as Antigravity wrote it.
 *
 * A provider read has to stay interactive, so the whole probe runs under one
 * hard budget and every phase names itself when it runs out of time. The two
 * costs worth avoiding — sweeping a ~200 MB binary and spending a network round
 * trip on a refresh — are both cached: the binary's match offsets on disk (no
 * secret is ever written there) and the access token in memory only.
 *
 * Run directly to print the raw JSON on stdout, which is how a `command` source
 * would consume it:
 *
 *   node antigravity-probe.server.ts
 */

import { execFile } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AntigravityQuotaBucket {
  id: string;
  label: string;
  group: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface AntigravityQuota {
  source: string;
  fetchedAt: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityCredential {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
}

export class AntigravityProbeError extends Error {}

/** Where the OAuth item lives, in both credential stores. */
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
/** go-keyring wraps non-UTF-8-safe payloads; the Linux backend usually does not. */
const GO_KEYRING_PREFIX = "go-keyring-base64:";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_BASE_URLS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];
const QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";

/** Send a token only if it survives the round trip with room to spare. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * One hard ceiling for the whole probe, and a cap per phase inside it. The
 * ceiling is what keeps a provider read interactive; the per-phase caps are
 * what make a failure say which step broke.
 */
const PROBE_BUDGET_MS = 9_000;
const PHASE_KEYRING_MS = 4_000;
const PHASE_OAUTH_CLIENT_MS = 4_000;
const PHASE_REFRESH_MS = 5_000;
const PHASE_QUOTA_MS = 5_000;
const SUBPROCESS_TIMEOUT_MS = 3_000;

/**
 * The buckets `retrieveUserQuotaSummary` reports, in a fixed order so a
 * `readings` entry can address one as `buckets[N]` and keep addressing the same
 * window forever. Every one is always emitted, with null readings when the
 * response omits it, so an absent bucket never shifts the indexes.
 */
const KNOWN_BUCKETS: readonly { id: string; label: string; group: string }[] = [
  { id: "gemini-5h", label: "Session", group: "Gemini Models" },
  { id: "gemini-weekly", label: "Weekly", group: "Gemini Models" },
  { id: "3p-5h", label: "Session", group: "Claude and GPT models" },
  { id: "3p-weekly", label: "Weekly", group: "Claude and GPT models" },
];

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface ProbeDeadline {
  remainingMs(): number;
}

export function startDeadline(totalMs: number, nowMs: number = Date.now()): ProbeDeadline {
  const endMs = nowMs + totalMs;
  return { remainingMs: () => endMs - Date.now() };
}

/**
 * Runs one phase under the smaller of its own cap and whatever is left of the
 * probe budget, and gives it a signal so a hung socket is actually torn down
 * rather than merely abandoned.
 */
export async function runPhase<T>(
  deadline: ProbeDeadline,
  label: string,
  capMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const budgetMs = Math.min(capMs, deadline.remainingMs());
  if (budgetMs <= 0) {
    throw new AntigravityProbeError(
      `${label} never started: the ${Math.round(PROBE_BUDGET_MS / 1000)}s probe budget was already spent`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const expiry = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          new AntigravityProbeError(`${label} timed out after ${(budgetMs / 1000).toFixed(1)}s`),
        ),
      { once: true },
    );
  });
  // The loser of the race still settles; give both a handler so neither
  // surfaces as an unhandled rejection.
  expiry.catch(() => {});
  const work = run(controller.signal);
  work.catch(() => {});

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function firstScalar(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The stored item is `{"token":{"access_token","token_type","refresh_token",
 * "expiry"},"auth_method":…}`. Tolerate the flat shape and the base64 wrapper
 * too: both appear across go-keyring backends and Antigravity versions.
 */
export function parseStoredCredential(raw: string): AntigravityCredential | null {
  let payload = raw.trim();
  if (payload.startsWith(GO_KEYRING_PREFIX)) {
    payload = Buffer.from(payload.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf8");
  }
  let document: unknown;
  try {
    document = JSON.parse(payload);
  } catch {
    return null;
  }
  const root = asRecord(document);
  if (root === null) return null;
  const token = asRecord(root.token) ?? root;

  const accessToken = firstString(token, ["access_token", "accessToken"]);
  const refreshToken = firstString(token, ["refresh_token", "refreshToken"]);
  const expiry = firstScalar(token, ["expiry", "expires_at", "expiresAt", "expiry_date"]);
  if (accessToken === null && refreshToken === null) return null;

  return { accessToken, refreshToken, expiresAtMs: parseExpiry(expiry) };
}

/**
 * Antigravity writes an RFC 3339 string; the Google OAuth libraries other
 * builds embed write `expiry_date` as a number. Accept both.
 */
function parseExpiry(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Bare numbers are epoch seconds below the year-5138 boundary, else millis.
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

export function isAccessTokenUsable(credential: AntigravityCredential, nowMs: number): boolean {
  if (credential.accessToken === null) return false;
  if (credential.expiresAtMs === null) return true;
  return credential.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > nowMs;
}

// ---------------------------------------------------------------------------
// D-Bus: just enough of the wire format to read one Secret Service item
// ---------------------------------------------------------------------------

/** Splits a signature into its complete top-level types: "sv" -> ["s","v"]. */
function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let index = 0;
  while (index < signature.length) {
    const start = index;
    while (signature[index] === "a") index += 1;
    const code = signature[index];
    if (code === "(" || code === "{") {
      const close = code === "(" ? ")" : "}";
      let depth = 1;
      while (depth > 0) {
        index += 1;
        if (signature[index] === code) depth += 1;
        else if (signature[index] === close) depth -= 1;
      }
    }
    index += 1;
    types.push(signature.slice(start, index));
  }
  return types;
}

function alignmentOf(type: string): number {
  const code = type[0];
  if (code === "y" || code === "g" || code === "v") return 1;
  if (code === "u" || code === "i" || code === "b" || code === "a") return 4;
  if (code === "s" || code === "o") return 4;
  return 8; // struct, dict entry, x, t, d
}

class DBusWriter {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }

  align(boundary: number): void {
    while (this.bytes.length % boundary !== 0) this.bytes.push(0);
  }

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  raw(buffer: Buffer): void {
    for (const value of buffer) this.bytes.push(value);
  }

  uint32(value: number): void {
    this.align(4);
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  patchUint32(offset: number, value: number): void {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >>> 8) & 0xff;
    this.bytes[offset + 2] = (value >>> 16) & 0xff;
    this.bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  value(type: string, value: unknown): void {
    const code = type[0];
    if (code === "y") return this.byte(value as number);
    if (code === "u") return this.uint32(value as number);
    if (code === "s" || code === "o") {
      const encoded = Buffer.from(String(value), "utf8");
      this.uint32(encoded.length);
      this.raw(encoded);
      return this.byte(0);
    }
    if (code === "g") {
      const encoded = Buffer.from(String(value), "ascii");
      this.byte(encoded.length);
      this.raw(encoded);
      return this.byte(0);
    }
    if (code === "v") {
      const variant = value as { signature: string; value: unknown };
      this.value("g", variant.signature);
      return this.value(variant.signature, variant.value);
    }
    if (code === "a") {
      const element = type.slice(1);
      this.uint32(0);
      const lengthOffset = this.length - 4;
      this.align(alignmentOf(element));
      const start = this.length;
      for (const item of value as unknown[]) {
        this.align(alignmentOf(element));
        this.value(element, item);
      }
      return this.patchUint32(lengthOffset, this.length - start);
    }
    if (code === "(" || code === "{") {
      this.align(8);
      const members = splitSignature(type.slice(1, -1));
      const items = value as unknown[];
      members.forEach((member, index) => this.value(member, items[index]));
      return;
    }
    throw new AntigravityProbeError(`Unsupported D-Bus type "${type}"`);
  }
}

class DBusReader {
  private readonly buffer: Buffer;
  private offset: number;

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  align(boundary: number): void {
    while (this.offset % boundary !== 0) this.offset += 1;
  }

  byte(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  uint32(): number {
    this.align(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  value(type: string): unknown {
    const code = type[0];
    if (code === "y") return this.byte();
    if (code === "b") return this.uint32() !== 0;
    if (code === "u") return this.uint32();
    if (code === "s" || code === "o") {
      const length = this.uint32();
      const text = this.buffer.toString("utf8", this.offset, this.offset + length);
      this.offset += length + 1;
      return text;
    }
    if (code === "g") {
      const length = this.byte();
      const text = this.buffer.toString("ascii", this.offset, this.offset + length);
      this.offset += length + 1;
      return text;
    }
    if (code === "v") {
      const signature = this.value("g") as string;
      return this.value(signature);
    }
    if (code === "a") {
      const element = type.slice(1);
      const length = this.uint32();
      this.align(alignmentOf(element));
      const end = this.offset + length;
      // A byte array is the secret payload; hand it back whole.
      if (element === "y") {
        const bytes = this.buffer.subarray(this.offset, end);
        this.offset = end;
        return Buffer.from(bytes);
      }
      const items: unknown[] = [];
      while (this.offset < end) {
        this.align(alignmentOf(element));
        items.push(this.value(element));
      }
      return items;
    }
    if (code === "(" || code === "{") {
      this.align(8);
      return splitSignature(type.slice(1, -1)).map((member) => this.value(member));
    }
    throw new AntigravityProbeError(`Unsupported D-Bus type "${type}"`);
  }
}

export interface DBusMessage {
  type: number;
  replySerial: number | null;
  errorName: string | null;
  signature: string;
  body: Buffer;
}

const MESSAGE_TYPE_METHOD_RETURN = 2;
const MESSAGE_TYPE_ERROR = 3;

export interface DBusCallFields {
  path: string;
  iface: string;
  member: string;
  destination: string;
}

export function encodeDBusMethodCall(
  serial: number,
  fields: DBusCallFields,
  signature: string,
  args: readonly unknown[],
): Buffer {
  const body = new DBusWriter();
  splitSignature(signature).forEach((type, index) => {
    body.align(alignmentOf(type));
    body.value(type, args[index]);
  });
  const bodyBuffer = body.toBuffer();

  const header = new DBusWriter();
  header.byte(0x6c); // little-endian
  header.byte(1); // METHOD_CALL
  header.byte(0); // flags
  header.byte(1); // protocol version
  header.uint32(bodyBuffer.length);
  header.uint32(serial);

  const headerFields: [number, string, string][] = [
    [1, "o", fields.path],
    [2, "s", fields.iface],
    [3, "s", fields.member],
    [6, "s", fields.destination],
  ];
  if (signature !== "") headerFields.push([8, "g", signature]);
  header.value(
    "a(yv)",
    headerFields.map(([code, type, value]) => [code, { signature: type, value }]),
  );
  header.align(8);

  return Buffer.concat([header.toBuffer(), bodyBuffer]);
}

export function decodeDBusMessages(buffer: Buffer): { messages: DBusMessage[]; rest: Buffer } {
  const messages: DBusMessage[] = [];
  let cursor = 0;
  while (buffer.length - cursor >= 16) {
    const bodyLength = buffer.readUInt32LE(cursor + 4);
    const fieldsLength = buffer.readUInt32LE(cursor + 12);
    const headerLength = 16 + fieldsLength;
    const paddedHeader = headerLength + ((8 - (headerLength % 8)) % 8);
    const total = paddedHeader + bodyLength;
    if (buffer.length - cursor < total) break;

    // Messages sit back to back with no inter-message padding, so alignment has
    // to be measured from this message's own start, not from the buffer's.
    const reader = new DBusReader(buffer.subarray(cursor), 12);
    const fields = reader.value("a(yv)") as [number, unknown][];
    let replySerial: number | null = null;
    let errorName: string | null = null;
    let signature = "";
    for (const [code, value] of fields) {
      if (code === 5) replySerial = value as number;
      else if (code === 4) errorName = value as string;
      else if (code === 8) signature = value as string;
    }
    messages.push({
      type: buffer.readUInt8(cursor + 1),
      replySerial,
      errorName,
      signature,
      body: buffer.subarray(cursor + paddedHeader, cursor + total),
    });
    cursor += total;
  }
  return { messages, rest: buffer.subarray(cursor) };
}

/** Splits a decoded message's body into the values its signature declares. */
export function decodeDBusBody(message: DBusMessage): unknown[] {
  const reader = new DBusReader(message.body);
  return splitSignature(message.signature).map((type) => reader.value(type));
}

function sessionBusPath(): string {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
  for (const candidate of address.split(";")) {
    const abstract = /^unix:.*\babstract=([^,]+)/.exec(candidate)?.[1];
    if (abstract !== undefined) return `\0${abstract}`;
    const path = /^unix:.*\bpath=([^,]+)/.exec(candidate)?.[1];
    if (path !== undefined) return path;
  }
  return `/run/user/${userInfo().uid}/bus`;
}

/**
 * A Secret Service session belongs to the connection that opened it, so
 * `OpenSession`, `SearchItems` and `GetSecret` all have to ride one socket —
 * which is why this speaks D-Bus directly instead of shelling out to
 * `secret-tool` (absent on plenty of installs) or `gdbus` (one connection per
 * invocation).
 */
class DBusConnection {
  private serial = 1;
  private pending = new Map<number, (outcome: DBusMessage | Error) => void>();
  private inbox: Buffer = Buffer.alloc(0);

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.inbox = Buffer.concat([this.inbox, chunk]);
      const { messages, rest } = decodeDBusMessages(this.inbox);
      this.inbox = rest;
      for (const message of messages) {
        if (message.replySerial === null) continue;
        this.pending.get(message.replySerial)?.(message);
        this.pending.delete(message.replySerial);
      }
    });
    // Without this an aborted phase would leave every in-flight call pending
    // forever on a socket nobody is reading any more.
    const fail = () => {
      const closed = new AntigravityProbeError("the D-Bus connection closed early");
      for (const settle of this.pending.values()) settle(closed);
      this.pending.clear();
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }

  static async connect(signal: AbortSignal): Promise<DBusConnection> {
    const socket = createConnection({ path: sessionBusPath() });
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });

      const uid = Buffer.from(String(userInfo().uid), "ascii").toString("hex");
      const greeting = await new Promise<string>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString("ascii")));
        socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
      });
      if (!greeting.startsWith("OK")) {
        throw new AntigravityProbeError(
          `the D-Bus daemon rejected EXTERNAL auth: ${greeting.trim()}`,
        );
      }
      socket.write("BEGIN\r\n");
    } catch (error) {
      socket.destroy();
      throw error;
    }

    const connection = new DBusConnection(socket);
    await connection.call(
      {
        path: "/org/freedesktop/DBus",
        iface: "org.freedesktop.DBus",
        member: "Hello",
        destination: "org.freedesktop.DBus",
      },
      "",
      [],
    );
    return connection;
  }

  close(): void {
    this.socket.destroy();
  }

  call(fields: DBusCallFields, signature: string, args: readonly unknown[]): Promise<unknown[]> {
    const serial = this.serial;
    this.serial += 1;
    return new Promise<unknown[]>((resolve, reject) => {
      this.pending.set(serial, (outcome) => {
        if (outcome instanceof Error) {
          reject(outcome);
          return;
        }
        if (outcome.type === MESSAGE_TYPE_ERROR) {
          reject(
            new AntigravityProbeError(
              `the keyring returned ${outcome.errorName ?? "an error"} for ${fields.member}`,
            ),
          );
          return;
        }
        if (outcome.type !== MESSAGE_TYPE_METHOD_RETURN) {
          reject(
            new AntigravityProbeError(`the keyring gave an unexpected reply to ${fields.member}`),
          );
          return;
        }
        resolve(decodeDBusBody(outcome));
      });

      this.socket.write(encodeDBusMethodCall(serial, fields, signature, args));
    });
  }
}

const SECRETS_DESTINATION = "org.freedesktop.secrets";
const SECRETS_PATH = "/org/freedesktop/secrets";

async function readSecretServiceItem(
  attributes: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  const connection = await DBusConnection.connect(signal);
  try {
    const [, session] = (await connection.call(
      {
        path: SECRETS_PATH,
        iface: "org.freedesktop.Secret.Service",
        member: "OpenSession",
        destination: SECRETS_DESTINATION,
      },
      "sv",
      ["plain", { signature: "s", value: "" }],
    )) as [unknown, string];

    const [unlocked, locked] = (await connection.call(
      {
        path: SECRETS_PATH,
        iface: "org.freedesktop.Secret.Service",
        member: "SearchItems",
        destination: SECRETS_DESTINATION,
      },
      "a{ss}",
      [Object.entries(attributes)],
    )) as [string[], string[]];

    const item = unlocked[0];
    if (item === undefined) {
      // Unlocking needs an interactive prompt this process cannot answer, so
      // say what to do rather than blocking on a Prompt object.
      if (locked.length > 0) {
        throw new AntigravityProbeError(
          "the Antigravity credential is in a locked keyring; unlock the login keyring and read again",
        );
      }
      return null;
    }

    // Secret is (session, parameters, value, contentType); the value is field 2.
    const [secret] = (await connection.call(
      {
        path: item,
        iface: "org.freedesktop.Secret.Item",
        member: "GetSecret",
        destination: SECRETS_DESTINATION,
      },
      "o",
      [session],
    )) as [unknown[]];
    const value = secret[2];
    return Buffer.isBuffer(value) ? value.toString("utf8") : null;
  } finally {
    connection.close();
  }
}

async function readWindowsCredentialItem(target: string): Promise<string | null> {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCred {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(ptr);
        }
    }
}
'@
$res = [WinCred]::Read("${target}")
if ($res) {
    [Console]::Out.Write($res)
}
`;

  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
    const trimmed = stdout.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

async function readKeychainItem(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
    const trimmed = stdout.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

export async function loadStoredCredential(signal: AbortSignal): Promise<AntigravityCredential> {
  const raw =
    process.platform === "darwin"
      ? await readKeychainItem(KEYRING_SERVICE, KEYRING_ACCOUNT)
      : process.platform === "win32"
        ? await readWindowsCredentialItem(`${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`)
        : await readSecretServiceItem(
            { service: KEYRING_SERVICE, username: KEYRING_ACCOUNT },
            signal,
          );

  if (raw === null) {
    throw new AntigravityProbeError(
      "no stored Antigravity credential (keyring item service=gemini, account=antigravity); sign in with Antigravity or `agy` first",
    );
  }
  const credential = parseStoredCredential(raw);
  if (credential === null) {
    throw new AntigravityProbeError(
      "the stored Antigravity credential is not the expected JSON token object",
    );
  }
  return credential;
}

// ---------------------------------------------------------------------------
// OAuth client, read out of the installed binary
// ---------------------------------------------------------------------------

export interface OAuthClientMatch {
  offset: number;
  length: number;
}

export interface OAuthClientMatches {
  clientIds: OAuthClientMatch[];
  clientSecrets: OAuthClientMatch[];
}

export interface OAuthClientCache extends OAuthClientMatches {
  version: number;
  binaryPath: string;
  size: number;
  mtimeMs: number;
}

const OAUTH_CACHE_VERSION = 1;
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";
const CLIENT_SECRET_PREFIX = "GOCSPX-";
/** A client id is at most this many bytes of local part before the suffix. */
const CLIENT_ID_LOCAL_MAX = 96;
const CLIENT_SECRET_LENGTH = CLIENT_SECRET_PREFIX.length + 28;
const CLIENT_ID_EXACT = /^[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_EXACT = /^GOCSPX-[A-Za-z0-9_-]{28}$/;
/** Widest candidate, so a chunked scan can overlap by exactly this much. */
const SCAN_OVERLAP = CLIENT_ID_LOCAL_MAX + CLIENT_ID_SUFFIX.length;

/**
 * Locates candidates by their fixed marker with `Buffer.indexOf` — a native
 * search — and only then runs a regex over the few dozen bytes around each hit.
 * Decoding the whole binary to a string and sweeping it with two global regexes
 * costs about four times as much and allocates a string per chunk.
 */
export function findOAuthClientMatches(chunk: Buffer, baseOffset = 0): OAuthClientMatches {
  const clientIds: OAuthClientMatch[] = [];
  for (let at = chunk.indexOf(CLIENT_ID_SUFFIX, 0, "latin1"); at !== -1; ) {
    const from = Math.max(0, at - CLIENT_ID_LOCAL_MAX);
    const window = chunk.toString("latin1", from, at + CLIENT_ID_SUFFIX.length);
    const found = /[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com$/.exec(window);
    if (found !== null) {
      clientIds.push({ offset: baseOffset + from + found.index, length: found[0].length });
    }
    at = chunk.indexOf(CLIENT_ID_SUFFIX, at + 1, "latin1");
  }

  const clientSecrets: OAuthClientMatch[] = [];
  for (let at = chunk.indexOf(CLIENT_SECRET_PREFIX, 0, "latin1"); at !== -1; ) {
    const window = chunk.toString("latin1", at, at + CLIENT_SECRET_LENGTH);
    if (CLIENT_SECRET_EXACT.test(window)) {
      clientSecrets.push({ offset: baseOffset + at, length: CLIENT_SECRET_LENGTH });
    }
    at = chunk.indexOf(CLIENT_SECRET_PREFIX, at + 1, "latin1");
  }

  return { clientIds, clientSecrets };
}

/** True when the cache was written for this exact file, unchanged since. */
export function isOAuthCacheFresh(
  cache: unknown,
  binaryPath: string,
  stat: { size: number; mtimeMs: number },
): cache is OAuthClientCache {
  const record = asRecord(cache);
  if (record === null) return false;
  return (
    record.version === OAUTH_CACHE_VERSION &&
    record.binaryPath === binaryPath &&
    record.size === stat.size &&
    record.mtimeMs === stat.mtimeMs &&
    Array.isArray(record.clientIds) &&
    Array.isArray(record.clientSecrets) &&
    record.clientIds.length > 0 &&
    record.clientSecrets.length > 0
  );
}

function cacheDirectory(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "usage-limits");
}

function cachePath(): string {
  return join(cacheDirectory(), "antigravity-oauth-client.json");
}

async function locateAgyBinary(): Promise<string> {
  const override = process.env.ANTIGRAVITY_AGY_PATH;
  if (override !== undefined && existsSync(override)) return override;

  const candidates = [
    join(homedir(), ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe"),
    join(homedir(), ".local", "bin", "agy.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      ["agy"],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
    const resolved = stdout.split(/\r?\n/)[0]?.trim();
    if (resolved !== undefined && resolved !== "" && existsSync(resolved)) return resolved;
  } catch {
    // Not on PATH either.
  }

  throw new AntigravityProbeError(
    "cannot find the `agy` binary to read Antigravity's OAuth client from; set ANTIGRAVITY_AGY_PATH",
  );
}

/** Reads back the exact bytes a cached match points at, and re-validates them. */
function readMatches(
  binaryPath: string,
  matches: readonly OAuthClientMatch[],
  shape: RegExp,
): string[] | null {
  const handle = openSync(binaryPath, "r");
  try {
    const values: string[] = [];
    for (const { offset, length } of matches) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0 || length > 256) {
        return null;
      }
      const buffer = Buffer.allocUnsafe(length);
      if (readSync(handle, buffer, 0, length, offset) !== length) return null;
      const value = buffer.toString("latin1");
      if (!shape.test(value)) return null;
      values.push(value);
    }
    return values.length > 0 ? values : null;
  } finally {
    closeSync(handle);
  }
}

async function scanBinary(binaryPath: string, signal: AbortSignal): Promise<OAuthClientMatches> {
  const clientIds: OAuthClientMatch[] = [];
  const clientSecrets: OAuthClientMatch[] = [];
  const seen = new Set<string>();
  let carry: Buffer = Buffer.alloc(0);
  let consumed = 0;

  const stream = createReadStream(binaryPath, { highWaterMark: 8 * 1024 * 1024 });
  signal.addEventListener("abort", () => stream.destroy(), { once: true });

  for await (const chunk of stream) {
    const block = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
    const blockOffset = consumed - carry.length;
    const found = findOAuthClientMatches(block, blockOffset);
    // The overlap means a candidate spanning a chunk boundary is seen twice.
    for (const match of found.clientIds) {
      if (seen.has(`i${match.offset}`)) continue;
      seen.add(`i${match.offset}`);
      clientIds.push(match);
    }
    for (const match of found.clientSecrets) {
      if (seen.has(`s${match.offset}`)) continue;
      seen.add(`s${match.offset}`);
      clientSecrets.push(match);
    }
    consumed += (chunk as Buffer).length;
    carry = block.subarray(Math.max(0, block.length - SCAN_OVERLAP));
  }

  return { clientIds, clientSecrets };
}

interface OAuthClient {
  clientIds: string[];
  clientSecrets: string[];
}

/**
 * Held for the life of the process so a second read in the same daemon never
 * touches the binary again. Only the offsets reach disk; the secret itself
 * lives here and nowhere else.
 */
let memoizedClient: {
  binaryPath: string;
  size: number;
  mtimeMs: number;
  client: OAuthClient;
} | null = null;

export async function resolveOAuthClient(signal: AbortSignal): Promise<OAuthClient> {
  const binaryPath = await locateAgyBinary();
  const stat = statSync(binaryPath);

  if (
    memoizedClient !== null &&
    memoizedClient.binaryPath === binaryPath &&
    memoizedClient.size === stat.size &&
    memoizedClient.mtimeMs === stat.mtimeMs
  ) {
    return memoizedClient.client;
  }

  const remember = (client: OAuthClient) => {
    memoizedClient = { binaryPath, size: stat.size, mtimeMs: stat.mtimeMs, client };
    return client;
  };

  let cached: unknown;
  try {
    cached = JSON.parse(readFileSync(cachePath(), "utf8"));
  } catch {
    cached = null;
  }
  if (isOAuthCacheFresh(cached, binaryPath, stat)) {
    const clientIds = readMatches(binaryPath, cached.clientIds, CLIENT_ID_EXACT);
    const clientSecrets = readMatches(binaryPath, cached.clientSecrets, CLIENT_SECRET_EXACT);
    if (clientIds !== null && clientSecrets !== null) {
      return remember({ clientIds, clientSecrets });
    }
  }

  const matches = await scanBinary(binaryPath, signal);
  const clientIds = readMatches(binaryPath, matches.clientIds, CLIENT_ID_EXACT);
  const clientSecrets = readMatches(binaryPath, matches.clientSecrets, CLIENT_SECRET_EXACT);
  if (clientIds === null || clientSecrets === null) {
    throw new AntigravityProbeError(`no OAuth client credentials found in ${binaryPath}`);
  }

  const record: OAuthClientCache = {
    version: OAUTH_CACHE_VERSION,
    binaryPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    clientIds: matches.clientIds,
    clientSecrets: matches.clientSecrets,
  };
  try {
    mkdirSync(cacheDirectory(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // A read-only or missing PASEO_HOME costs a rescan next time, nothing more.
  }

  return remember({ clientIds, clientSecrets });
}

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

/** In memory only, for the life of the process: never written to disk. */
let memoizedAccessToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Antigravity ships more than one client id/secret; only one pair is the CLI's.
 * Rather than guess, try each pair against the token endpoint and keep the one
 * Google accepts. Google does not rotate the refresh token on this grant, so
 * the stored credential stays valid and is never written back.
 */
export async function refreshAccessToken(
  refreshToken: string,
  signal: AbortSignal,
): Promise<{ token: string; expiresInSeconds: number }> {
  const { clientIds, clientSecrets } = await resolveOAuthClient(signal);

  let lastFailure = "no attempt was made";
  for (const clientId of clientIds) {
    for (const clientSecret of clientSecrets) {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        signal,
      });
      if (!response.ok) {
        lastFailure = `Google returned HTTP ${response.status} for client ${clientId.slice(0, 13)}`;
        continue;
      }
      const document = asRecord(await response.json());
      const token = document === null ? null : firstString(document, ["access_token"]);
      if (token !== null) {
        const expiresIn = document === null ? null : firstScalar(document, ["expires_in"]);
        return { token, expiresInSeconds: Number(expiresIn) > 0 ? Number(expiresIn) : 3600 };
      }
      lastFailure = "Google returned no access_token";
    }
  }
  throw new AntigravityProbeError(`could not refresh the Antigravity access token: ${lastFailure}`);
}

async function acquireAccessToken(deadline: ProbeDeadline): Promise<string> {
  if (
    memoizedAccessToken !== null &&
    memoizedAccessToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()
  ) {
    return memoizedAccessToken.token;
  }

  const credential = await runPhase(
    deadline,
    "reading the credential from the keyring",
    PHASE_KEYRING_MS,
    (signal) => loadStoredCredential(signal),
  );

  if (isAccessTokenUsable(credential, Date.now())) {
    return credential.accessToken as string;
  }
  if (credential.refreshToken === null) {
    throw new AntigravityProbeError(
      "the stored Antigravity access token has expired and there is no refresh token; sign in again",
    );
  }

  // Finding the OAuth client is its own phase because on a cold cache it reads
  // a ~200 MB binary, and a user deserves to be told that is what stalled.
  const refreshToken = credential.refreshToken;
  const refreshed = await runPhase(
    deadline,
    "refreshing the access token",
    PHASE_REFRESH_MS + PHASE_OAUTH_CLIENT_MS,
    (signal) => refreshAccessToken(refreshToken, signal),
  );
  memoizedAccessToken = {
    token: refreshed.token,
    expiresAtMs: Date.now() + refreshed.expiresInSeconds * 1000,
  };
  return refreshed.token;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * Maps the `retrieveUserQuotaSummary` payload onto the fixed bucket list.
 * The service reports what is *left*; the plugin reads what is *used*.
 */
export function mapQuotaSummary(
  document: unknown,
  source: string,
  fetchedAt: string,
): AntigravityQuota {
  const root = asRecord(document);
  const groups = Array.isArray(root?.groups) ? root.groups : [];

  const byId = new Map<string, { bucket: Record<string, unknown>; group: string | null }>();
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (group === null) continue;
    const groupName = typeof group.displayName === "string" ? group.displayName : null;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      const id = bucket === null ? null : bucket.bucketId;
      if (typeof id !== "string" || byId.has(id)) continue;
      byId.set(id, { bucket: bucket as Record<string, unknown>, group: groupName });
    }
  }

  const buckets = KNOWN_BUCKETS.map(({ id, label, group }) => {
    const found = byId.get(id);
    const remaining = found === undefined ? null : found.bucket.remainingFraction;
    const resetTime = found === undefined ? null : found.bucket.resetTime;
    return {
      id,
      label,
      group: found?.group ?? group,
      usedPercent:
        typeof remaining === "number" && Number.isFinite(remaining)
          ? Math.min(100, Math.max(0, (1 - remaining) * 100))
          : null,
      resetsAt:
        typeof resetTime === "string" && !Number.isNaN(Date.parse(resetTime)) ? resetTime : null,
    };
  });

  return { source, fetchedAt, buckets };
}

async function fetchQuotaSummary(
  accessToken: string,
  signal: AbortSignal,
): Promise<{ document: unknown; source: string }> {
  let lastFailure = "no attempt was made";
  for (const base of CLOUD_CODE_BASE_URLS) {
    const url = base + QUOTA_SUMMARY_PATH;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "antigravity",
        },
        body: "{}",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = `${url} was unreachable: ${error instanceof Error ? error.message : "error"}`;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      // A token this process just minted should not be rejected, so drop it
      // rather than serving the same rejection from cache on the next read.
      memoizedAccessToken = null;
      throw new AntigravityProbeError(
        `Antigravity rejected the access token (HTTP ${response.status}); sign in with Antigravity or \`agy\` again`,
      );
    }
    if (!response.ok) {
      lastFailure = `${url} returned HTTP ${response.status}`;
      continue;
    }
    return { document: await response.json(), source: url };
  }
  throw new AntigravityProbeError(`could not reach the Antigravity quota endpoint: ${lastFailure}`);
}

export async function probeAntigravityQuota(): Promise<AntigravityQuota> {
  const deadline = startDeadline(PROBE_BUDGET_MS);
  const accessToken = await acquireAccessToken(deadline);
  const { document, source } = await runPhase(
    deadline,
    "fetching the quota summary",
    PHASE_QUOTA_MS,
    (signal) => fetchQuotaSummary(accessToken, signal),
  );
  return mapQuotaSummary(document, source, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Direct execution: a `command` source runs this and reads stdout
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await probeAntigravityQuota(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`);

if (isDirectRun) {
  void main();
}
