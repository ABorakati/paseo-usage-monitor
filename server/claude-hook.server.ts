import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClaudeStatusLineStatus } from "../shared/claude-hook.shared";
import { STATUSLINE_HOOK_SCRIPT } from "./statusline-hook-script.server";

const execFileAsync = promisify(execFile);

const SCRIPT_BASENAME = "paseo-statusline.mjs";
const WRAP_BASENAME = "paseo-statusline-wrap.json";
const LIMITS_BASENAME = "paseo-rate-limits.json";
const BACKUP_SUFFIX = ".paseo-usage-monitor.bak";
const NODE_PROBE_TIMEOUT_MS = 3_000;

/**
 * The statusLine slot holds one command, so installing this hook displaces
 * whatever was there. The displaced command is recorded rather than dropped:
 * the hook runs it with the same payload and forwards its stdout, so the user's
 * status line reads exactly as it did before.
 *
 * Everything goes through these adapters, because the interesting cases are all
 * on disk: a settings file that is not JSON, a slot another tool owns, an
 * install run twice.
 */
export interface ClaudeHookAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  mkdirp(directory: string): void;
  exists(path: string): boolean;
  /** The Node invocation a statusline command can call, or null when Node is not on PATH. */
  resolveNodeCommand(): Promise<string | null>;
}

export function createNodeClaudeHookAdapters(): ClaudeHookAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(path, contents) {
      writeFileSync(path, contents, "utf8");
    },
    rename(from, to) {
      renameSync(from, to);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
    mkdirp(directory) {
      mkdirSync(directory, { recursive: true });
    },
    exists(path) {
      return existsSync(path);
    },
    async resolveNodeCommand() {
      try {
        await execFileAsync("node", ["--version"], { timeout: NODE_PROBE_TIMEOUT_MS });
        return "node";
      } catch {
        return null;
      }
    },
  };
}

export interface ClaudeHookPaths {
  configDir: string;
  settingsPath: string;
  scriptPath: string;
  wrapPath: string;
  limitsPath: string;
  backupPath: string;
}

export interface ClaudeHookService {
  read(): Promise<ClaudeStatusLineStatus>;
  install(): Promise<ClaudeStatusLineStatus>;
  uninstall(): Promise<ClaudeStatusLineStatus>;
}

type SettingsRead =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "invalid" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveClaudeHookPaths(adapters: ClaudeHookAdapters): ClaudeHookPaths {
  const configured = adapters.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir =
    configured !== undefined && configured !== "" ? configured : join(adapters.homeDir, ".claude");
  return {
    configDir,
    settingsPath: join(configDir, "settings.json"),
    scriptPath: join(configDir, SCRIPT_BASENAME),
    wrapPath: join(configDir, WRAP_BASENAME),
    limitsPath: join(configDir, LIMITS_BASENAME),
    backupPath: join(configDir, "settings.json" + BACKUP_SUFFIX),
  };
}

/** Matched on the file name so an absolute path, a relative one and a quoted one all count. */
function isHookCommand(command: string | null): boolean {
  return command !== null && command.includes(SCRIPT_BASENAME);
}

function statusLineCommand(value: Record<string, unknown>): string | null {
  const statusLine = value.statusLine;
  if (!isPlainObject(statusLine)) return null;
  const command = statusLine.command;
  return typeof command === "string" && command.trim() !== "" ? command : null;
}

export function createClaudeHookService(adapters: ClaudeHookAdapters): ClaudeHookService {
  const paths = resolveClaudeHookPaths(adapters);
  let nodeCommand: string | null | undefined;

  async function resolveNode(): Promise<string | null> {
    if (nodeCommand === undefined) {
      nodeCommand = await adapters.resolveNodeCommand();
    }
    return nodeCommand;
  }

  function readSettings(): SettingsRead {
    const text = adapters.readFile(paths.settingsPath);
    if (text === null) return { kind: "missing" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "invalid" };
    }
    if (!isPlainObject(parsed)) return { kind: "invalid" };
    return { kind: "object", value: parsed };
  }

  function readWrappedCommand(): string | null {
    const text = adapters.readFile(paths.wrapPath);
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) return null;
      const command = parsed.command;
      return typeof command === "string" && command.trim() !== "" ? command : null;
    } catch {
      return null;
    }
  }

  /**
   * Written through a temporary file and renamed, and the user's own file is
   * copied aside once before the first write. Claude Code's settings carry
   * hooks and permissions this plugin has no business losing to a crash
   * halfway through a rewrite.
   */
  function writeSettings(value: Record<string, unknown>): void {
    adapters.mkdirp(paths.configDir);
    const existing = adapters.readFile(paths.settingsPath);
    if (existing !== null && !adapters.exists(paths.backupPath)) {
      adapters.writeFile(paths.backupPath, existing);
    }
    const staged = paths.settingsPath + ".paseo-usage-monitor.tmp";
    adapters.writeFile(staged, JSON.stringify(value, null, 2) + "\n");
    adapters.rename(staged, paths.settingsPath);
  }

  async function buildStatus(
    overrides: Partial<ClaudeStatusLineStatus> = {},
  ): Promise<ClaudeStatusLineStatus> {
    const settings = readSettings();
    const current = settings.kind === "object" ? statusLineCommand(settings.value) : null;
    return {
      configDir: paths.configDir,
      settingsPath: paths.settingsPath,
      scriptPath: paths.scriptPath,
      wrapPath: paths.wrapPath,
      limitsPath: paths.limitsPath,
      installed: isHookCommand(current),
      currentCommand: current,
      wrappedCommand: readWrappedCommand(),
      nodeCommand: (await resolveNode()) ?? null,
      message: null,
      ...overrides,
    };
  }

  return {
    read() {
      return buildStatus();
    },

    async install() {
      const node = await resolveNode();
      if (node === null) {
        return buildStatus({
          message:
            "Node.js is not on PATH, and Claude Code runs a statusline command through the shell. Install Node, or keep the OAuth preset.",
        });
      }
      const settings = readSettings();
      if (settings.kind === "invalid") {
        return buildStatus({
          message: paths.settingsPath + " is not valid JSON. Fix it, then install again.",
        });
      }
      const value = settings.kind === "object" ? settings.value : {};
      const current = statusLineCommand(value);
      // An existing hook means the wrap file is already the source of truth for
      // what to forward; a foreign command becomes that source now.
      const wrapped = isHookCommand(current) ? readWrappedCommand() : current;

      adapters.mkdirp(paths.configDir);
      adapters.writeFile(paths.scriptPath, STATUSLINE_HOOK_SCRIPT);
      if (wrapped !== null) {
        adapters.writeFile(paths.wrapPath, JSON.stringify({ command: wrapped }, null, 2) + "\n");
      } else {
        adapters.remove(paths.wrapPath);
      }

      const previous = isPlainObject(value.statusLine) ? value.statusLine : {};
      writeSettings({
        ...value,
        statusLine: {
          ...previous,
          type: "command",
          command: node + ' "' + paths.scriptPath + '"',
        },
      });

      return buildStatus({
        message:
          wrapped === null
            ? "Installed. Claude Code now writes its rate limits to " + paths.limitsPath + "."
            : "Installed. The previous status line command is forwarded unchanged.",
      });
    },

    async uninstall() {
      const settings = readSettings();
      if (settings.kind === "invalid") {
        return buildStatus({
          message: paths.settingsPath + " is not valid JSON. Fix it, then remove the hook.",
        });
      }
      const current = settings.kind === "object" ? statusLineCommand(settings.value) : null;
      if (!isHookCommand(current)) {
        return buildStatus({ message: "The statusline hook is not installed." });
      }

      const wrapped = readWrappedCommand();
      if (settings.kind === "object") {
        const previous = isPlainObject(settings.value.statusLine) ? settings.value.statusLine : {};
        if (wrapped !== null) {
          writeSettings({
            ...settings.value,
            statusLine: { ...previous, type: "command", command: wrapped },
          });
        } else {
          const { statusLine: _removed, ...rest } = settings.value;
          writeSettings(rest);
        }
      }

      adapters.remove(paths.wrapPath);
      adapters.remove(paths.scriptPath);
      // The preset reads this file, so leaving it behind would freeze the card
      // on the last reading with nothing saying the writer is gone.
      adapters.remove(paths.limitsPath);
      return buildStatus({
        message:
          wrapped === null
            ? "Removed. The statusLine setting is cleared."
            : "Removed. The previous status line command is back.",
      });
    },
  };
}
