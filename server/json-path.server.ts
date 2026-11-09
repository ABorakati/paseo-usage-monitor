/**
 * Reads a value out of a parsed JSON document using dot/bracket path syntax:
 * `data.usage`, `balance_infos[0].total_balance`, `["github.com"].oauth_token`.
 *
 * Providers are inconsistent about whether numbers arrive as numbers or as
 * strings ("110.00"), so `readNumberAtPath` coerces. A path that does not
 * resolve is `null` — a missing field is a normal outcome, not a failure.
 */

/**
 * One segment is a quoted bracket key (`["github.com"]`, `['a.b']`), a bare
 * bracket index (`[0]`), or a run of characters up to the next dot or bracket.
 * The quoted form exists because GitHub Copilot keys its credential file by
 * hostname, and `github.com` split on dots reads two keys that are not there.
 */
const SEGMENT_PATTERN = /\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]|[^.[\]]+/g;

const EPOCH_SECONDS_CEILING = 1e11;

export function pathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const match of path.matchAll(SEGMENT_PATTERN)) {
    const quoted = match[1] ?? match[2];
    segments.push(quoted === undefined ? match[0] : quoted.replace(/\\(.)/g, "$1"));
  }
  return segments;
}

export function readAtPath(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of pathSegments(path)) {
    if (current === null || typeof current !== "object") return null;
    current = Reflect.get(current, segment);
    if (current === undefined) return null;
  }
  return current ?? null;
}

export function readNumberAtPath(document: unknown, path: string): number | null {
  const value = readAtPath(document, path);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readStringAtPath(document: unknown, path: string): string | null {
  const value = readAtPath(document, path);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Providers express reset times as ISO strings, epoch seconds, or epoch
 * milliseconds. Normalize the numeric forms to an ISO string and hand an
 * already-textual timestamp back untouched. Numeric strings take the epoch
 * route too: Cursor reports its billing cycle as an epoch-milliseconds
 * string, and Date.parse leaves that unreadable.
 */
export function readTimestampAtPath(document: unknown, path: string): string | null {
  const value = readAtPath(document, path);
  if (typeof value === "string") {
    if (value.trim() !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return epochToIso(numeric);
    }
    return Number.isNaN(Date.parse(value)) ? null : value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return epochToIso(value);
}

function epochToIso(epoch: number): string | null {
  const millis = epoch < EPOCH_SECONDS_CEILING ? epoch * 1000 : epoch;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
