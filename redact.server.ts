/**
 * Deep secret scrubbing for URLs, error messages, and diagnostic outputs.
 * Prevents credentials, Bearer tokens, and API keys from leaking into GUI notices
 * or logs when an HTTP request or command fails.
 */

const DEFAULT_SENSITIVE_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "privatekey",
  "private_key",
  "authorization",
  "auth",
  "credential",
  "credentials",
];
const SENSITIVE_PARAM_PATTERN =
  /([?&](?:api[_-]?key|key|token|auth|secret|password)=)([^&\s"'\\]+)/gi;
const BEARER_PATTERN = /(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi;
const BASIC_AUTH_PATTERN = /(https?:\/\/[^:]+:)[^@]+(@)/gi;
const GENERIC_SECRET_PATTERN = /\b(sk-[a-zA-Z0-9_-]{8,})\b/g;

export interface RedactOptions {
  mask?: string;
  customSensitiveKeys?: readonly string[];
}

function isSensitiveKey(key: string, customKeys: readonly string[] = []): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return [...DEFAULT_SENSITIVE_KEYS, ...customKeys].some((sensitive) =>
    normalized.includes(sensitive.replace(/[-_]/g, "")),
  );
}

function maskToken(value: string, placeholder = "..."): string {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}${placeholder}${value.slice(-3)}`;
}

function redactString(text: string, mask: string): string {
  let sanitized = text.replace(BEARER_PATTERN, (_match, prefix: string, token: string) => {
    return `${prefix}${maskToken(token)}`;
  });
  sanitized = sanitized.replace(BASIC_AUTH_PATTERN, `$1${mask}$2`);
  sanitized = sanitized.replace(
    SENSITIVE_PARAM_PATTERN,
    (_match, prefix: string, paramValue: string) => {
      return `${prefix}${maskToken(paramValue)}`;
    },
  );
  sanitized = sanitized.replace(GENERIC_SECRET_PATTERN, (match: string) => maskToken(match));
  return sanitized;
}

/**
 * Traverses primitives, arrays, and record objects to mask credentials.
 */
export function redactSecrets<T>(target: T, options: RedactOptions = {}): T {
  const mask = options.mask ?? "[REDACTED]";
  const customKeys = options.customSensitiveKeys ?? [];

  if (target === null || target === undefined) {
    return target;
  }

  if (typeof target === "string") {
    return redactString(target, mask) as unknown as T;
  }

  if (Array.isArray(target)) {
    return target.map((item: unknown) => redactSecrets(item, options)) as unknown as T;
  }

  if (typeof target === "object") {
    const record = target as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "object" && value !== null) {
        copy[key] = redactSecrets(value, options);
      } else if (isSensitiveKey(key, customKeys)) {
        if (typeof value === "string") {
          copy[key] = maskToken(value);
        } else {
          copy[key] = mask;
        }
      } else if (typeof value === "string") {
        copy[key] = redactString(value, mask);
      } else {
        copy[key] = value;
      }
    }
    return copy as T;
  }

  return target;
}
