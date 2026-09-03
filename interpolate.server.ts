import type { UsageSource } from "./limits.shared";

/**
 * Expands `${NAME}` against resolved credentials so secrets stay out of the
 * config file. Resolution belongs to the caller's resolver: an unknown name
 * throws from there, because "which sources were tried" is knowledge this
 * module does not have. A `$` that does not open `${` stays literal.
 */

const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type ResolveVariable = (name: string) => string;

export function interpolate(template: string, resolve: (name: string) => string): string {
  return template.replace(VARIABLE_PATTERN, (_match, name: string) => resolve(name));
}

function interpolateLeaves(value: unknown, resolve: ResolveVariable): unknown {
  if (typeof value === "string") return interpolate(value, resolve);
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => interpolateLeaves(entry, resolve));
  }
  if (value === null || typeof value !== "object") return value;
  const entries: [string, unknown][] = Object.entries(value);
  const interpolated: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    interpolated[key] = interpolateLeaves(entry, resolve);
  }
  return interpolated;
}

function interpolateHeaders(
  headers: Record<string, string>,
  resolve: ResolveVariable,
): Record<string, string> {
  const interpolated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    interpolated[name] = interpolate(value, resolve);
  }
  return interpolated;
}

export function interpolateSource(
  source: UsageSource,
  resolve: (name: string) => string,
): UsageSource {
  if (source.kind === "command") {
    const command = source.command.map((argument) => interpolate(argument, resolve));
    if (source.cwd === undefined) return { ...source, command };
    return { ...source, command, cwd: interpolate(source.cwd, resolve) };
  }
  // A probe names a mechanism, not a request: it carries no interpolatable string.
  if (source.kind === "probe") return source;
  // A file source's `${VAR}` names an environment variable on this machine, not
  // a credential: expanding it here would look the name up in the wrong place
  // and fail as a missing credential. The reader expands those paths instead.
  if (source.kind === "file") return source;
  const url = interpolate(source.url, resolve);
  const headers = interpolateHeaders(source.headers, resolve);
  if (source.body === undefined) return { ...source, url, headers };
  return { ...source, url, headers, body: interpolateLeaves(source.body, resolve) };
}
