import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  createClaudeHookService,
  createNodeClaudeHookAdapters,
  resolveClaudeHookPaths,
  type ClaudeHookAdapters,
} from "./claude-hook.server";
import { STATUSLINE_HOOK_SCRIPT } from "./statusline-hook-script.server";

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-claude-hook-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function adaptersFor(root: string, nodeCommand: string | null = "node"): ClaudeHookAdapters {
  return {
    ...createNodeClaudeHookAdapters(),
    env: {},
    homeDir: root,
    resolveNodeCommand: async () => nodeCommand,
  };
}

function settingsPath(root: string): string {
  return join(root, ".claude", "settings.json");
}

function writeSettings(root: string, value: unknown): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(root), JSON.stringify(value, null, 2) + "\n");
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(root), "utf8")) as Record<string, unknown>;
}

describe("claude statusline hook", () => {
  test("the embedded hook is byte-identical to the shipped script", () => {
    const shipped = readFileSync(
      fileURLToPath(new URL("../statusline-hook.mjs", import.meta.url)),
      "utf8",
    );
    expect(STATUSLINE_HOOK_SCRIPT.replace(/\r\n/g, "\n")).toBe(shipped.replace(/\r\n/g, "\n"));
  });

  test("takes the slot and forwards the command it displaced", async () => {
    const root = createRoot();
    writeSettings(root, {
      model: "opus",
      statusLine: { type: "command", command: "~/.claude/ccline/ccline.exe", padding: 0 },
    });
    const paths = resolveClaudeHookPaths(adaptersFor(root));
    const service = createClaudeHookService(adaptersFor(root));

    const status = await service.install();

    expect(status.installed).toBe(true);
    expect(status.wrappedCommand).toBe("~/.claude/ccline/ccline.exe");
    expect(readFileSync(paths.scriptPath, "utf8")).toBe(STATUSLINE_HOOK_SCRIPT);
    expect(JSON.parse(readFileSync(paths.wrapPath, "utf8"))).toEqual({
      command: "~/.claude/ccline/ccline.exe",
    });
    const settings = readSettings(root);
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toEqual({
      type: "command",
      command: 'node "' + paths.scriptPath + '"',
      padding: 0,
    });
    expect(readFileSync(paths.backupPath, "utf8")).toContain("ccline");
  });

  test("reinstalling keeps forwarding the original command", async () => {
    const root = createRoot();
    writeSettings(root, {
      statusLine: { type: "command", command: "~/.claude/ccline/ccline.exe" },
    });
    const paths = resolveClaudeHookPaths(adaptersFor(root));
    const service = createClaudeHookService(adaptersFor(root));

    await service.install();
    await service.install();

    expect(JSON.parse(readFileSync(paths.wrapPath, "utf8"))).toEqual({
      command: "~/.claude/ccline/ccline.exe",
    });
    expect(readSettings(root).statusLine).toEqual({
      type: "command",
      command: 'node "' + paths.scriptPath + '"',
    });
  });

  test("restores the displaced command and clears its files on removal", async () => {
    const root = createRoot();
    writeSettings(root, {
      model: "opus",
      statusLine: { type: "command", command: "~/.claude/ccline/ccline.exe", padding: 0 },
    });
    const paths = resolveClaudeHookPaths(adaptersFor(root));
    const service = createClaudeHookService(adaptersFor(root));
    await service.install();

    const status = await service.uninstall();

    expect(status.installed).toBe(false);
    expect(readSettings(root)).toEqual({
      model: "opus",
      statusLine: { type: "command", command: "~/.claude/ccline/ccline.exe", padding: 0 },
    });
    expect(existsSync(paths.scriptPath)).toBe(false);
    expect(existsSync(paths.wrapPath)).toBe(false);
    expect(existsSync(paths.limitsPath)).toBe(false);
  });

  test("clears the slot when there was no command to restore", async () => {
    const root = createRoot();
    writeSettings(root, { model: "opus" });
    const service = createClaudeHookService(adaptersFor(root));

    await service.install();
    await service.uninstall();

    expect(readSettings(root)).toEqual({ model: "opus" });
  });

  test("refuses to install over a settings file that is not JSON", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath(root), "not json");
    const paths = resolveClaudeHookPaths(adaptersFor(root));
    const service = createClaudeHookService(adaptersFor(root));

    const status = await service.install();

    expect(status.installed).toBe(false);
    expect(status.message).toContain("not valid JSON");
    expect(readFileSync(settingsPath(root), "utf8")).toBe("not json");
    expect(existsSync(paths.scriptPath)).toBe(false);
  });

  test("refuses to install when Node is not on PATH", async () => {
    const root = createRoot();
    writeSettings(root, {});
    const paths = resolveClaudeHookPaths(adaptersFor(root));
    const service = createClaudeHookService(adaptersFor(root, null));

    const status = await service.install();

    expect(status.installed).toBe(false);
    expect(status.message).toContain("Node.js is not on PATH");
    expect(existsSync(paths.scriptPath)).toBe(false);
    expect(readSettings(root)).toEqual({});
  });
});
