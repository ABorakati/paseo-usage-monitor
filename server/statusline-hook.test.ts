import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/**
 * The hook runs as a real process, because that is how Claude Code runs it:
 * one JSON document on stdin, stdout is the status line, and the file it writes
 * is the whole contract with the `claude-statusline` preset.
 */
const SCRIPT_PATH = fileURLToPath(new URL("../statusline-hook.mjs", import.meta.url));

const roots: string[] = [];

function createConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-statusline-hook-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runHook(configDir: string, payload: unknown): string {
  return execFileSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

const RATE_LIMITS = {
  five_hour: { utilization: 42, resets_at: "2026-09-09T12:00:00Z" },
  seven_day: { utilization: 18, resets_at: "2026-09-12T00:00:00Z" },
};

test("writes rate_limits through unchanged and prints its own line", () => {
  const configDir = createConfigDir();

  const output = runHook(configDir, {
    model: { display_name: "Opus" },
    workspace: { current_dir: "/work/storefront" },
    rate_limits: RATE_LIMITS,
  });

  expect(JSON.parse(readFileSync(join(configDir, "paseo-rate-limits.json"), "utf8"))).toEqual(
    RATE_LIMITS,
  );
  expect(output.trim()).toBe("Opus · storefront · 5h 42% · 7d 18%");
});

test("leaves the last good file alone when the session has no plan quota", () => {
  const configDir = createConfigDir();
  const target = join(configDir, "paseo-rate-limits.json");
  writeFileSync(target, JSON.stringify(RATE_LIMITS));

  runHook(configDir, { model: { display_name: "Opus" }, rate_limits: null });

  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(RATE_LIMITS);
});

test("forwards the payload to the wrapped command and prints its output instead", () => {
  const configDir = createConfigDir();
  const helper = join(configDir, "echo-stdin.mjs");
  writeFileSync(
    helper,
    'let bytes = 0;\nprocess.stdin.on("data", (chunk) => { bytes += chunk.length; });\nprocess.stdin.on("end", () => { process.stdout.write("wrapped:" + bytes); });\n',
  );
  writeFileSync(
    join(configDir, "paseo-statusline-wrap.json"),
    JSON.stringify({ command: '"' + process.execPath + '" "' + helper + '"' }),
  );
  const payload = {
    model: { display_name: "Opus" },
    workspace: { current_dir: "/work/storefront" },
    rate_limits: RATE_LIMITS,
  };

  const output = runHook(configDir, payload);

  expect(output).toBe("wrapped:" + Buffer.byteLength(JSON.stringify(payload)));
  expect(JSON.parse(readFileSync(join(configDir, "paseo-rate-limits.json"), "utf8"))).toEqual(
    RATE_LIMITS,
  );
});
