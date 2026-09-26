#!/usr/bin/env node
/**
 * Claude Code statusline command for the Paseo usage-monitor plugin.
 *
 * Every turn Claude Code pipes one JSON document to the configured statusline
 * command. This hook does two things with it:
 *
 *   1. writes the "rate_limits" object, unchanged, to
 *      $CLAUDE_CONFIG_DIR/paseo-rate-limits.json (default ~/.claude), which the
 *      plugin's "claude-statusline" preset reads;
 *   2. forwards the same document to the statusline command that was
 *      configured before this one, if any, and lets its stdout stand as the
 *      status line.
 *
 * The object is written through as-is: the preset's reading paths are Claude
 * Code's own field names, so nothing here reshapes or renames anything.
 *
 * Install it from the plugin's Usage provider settings, or by hand: copy this
 * file to ~/.claude/paseo-statusline.mjs and set
 *
 *   "statusLine": { "type": "command", "command": "node ~/.claude/paseo-statusline.mjs" }
 *
 * in ~/.claude/settings.json. A command written into
 * ~/.claude/paseo-statusline-wrap.json as {"command": "..."} is forwarded.
 *
 * Node, not bash: Claude Code on Windows runs a statusline command through
 * cmd.exe, where a .sh script and a hardcoded "python3" do not work.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** A hung parent must not wedge the status line; stdin is read under a deadline. */
const STDIN_TIMEOUT_MS = 5000;
/** A wrapped command that never exits is killed rather than left running. */
const WRAPPED_TIMEOUT_MS = 10000;

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const LIMITS_PATH = join(CONFIG_DIR, "paseo-rate-limits.json");
const WRAP_PATH = join(CONFIG_DIR, "paseo-statusline-wrap.json");

function readStdin() {
  return new Promise(function (resolve) {
    const chunks = [];
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // eslint-disable-next-line promise/no-multiple-resolved -- the settled guard above makes every later call a no-op.
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", function (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

function writeLimits(limits) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    // Written through a temporary file in the same directory and renamed, so a
    // reader never sees half a document.
    const staged = join(CONFIG_DIR, ".paseo-rate-limits-" + process.pid + ".tmp");
    writeFileSync(staged, JSON.stringify(limits));
    renameSync(staged, LIMITS_PATH);
  } catch {
    // A status line is not the place to report a disk problem. The plugin names
    // the path it could not read instead.
  }
}

function readWrappedCommand() {
  try {
    const document = JSON.parse(readFileSync(WRAP_PATH, "utf8"));
    const command = document && typeof document.command === "string" ? document.command.trim() : "";
    return command === "" ? null : command;
  } catch {
    return null;
  }
}

/** Claude Code expands a leading ~ itself; a shell this spawns does not. */
function expandHome(command) {
  if (command === "~") return homedir();
  if (command.startsWith("~/") || command.startsWith("~\\")) {
    return join(homedir(), command.slice(2));
  }
  return command;
}

function forward(command, payload) {
  return new Promise(function (resolve) {
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // eslint-disable-next-line promise/no-multiple-resolved -- the settled guard above makes every later call a no-op.
      resolve();
    }
    let child;
    try {
      child = spawn(expandHome(command), { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(function () {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish();
    }, WRAPPED_TIMEOUT_MS);
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", function () {
      // The wrapped command may not read stdin; an EPIPE here is not a failure.
    });
    child.stdin.end(payload);
  });
}

/** The line printed when no command was configured before this one. */
function builtInLine(payload) {
  const parts = [];
  const model =
    payload.model && typeof payload.model.display_name === "string"
      ? payload.model.display_name
      : "";
  const directory =
    payload.workspace && typeof payload.workspace.current_dir === "string"
      ? payload.workspace.current_dir
      : "";
  if (model !== "") parts.push(model);
  if (directory !== "") parts.push(basename(directory));
  const limits = payload.rate_limits;
  if (limits && typeof limits === "object") {
    const windows = [
      ["5h", limits.five_hour],
      ["7d", limits.seven_day],
    ];
    for (const entry of windows) {
      const window = entry[1];
      if (!window || typeof window !== "object") continue;
      const used = window.utilization;
      if (typeof used === "number" && Number.isFinite(used)) {
        parts.push(entry[0] + " " + Math.round(used) + "%");
      }
    }
  }
  return parts.join(" \u00b7 ");
}

async function main() {
  const payload = await readStdin();
  if (payload.trim() === "") return;

  let document = null;
  try {
    document = JSON.parse(payload);
  } catch {
    document = null;
  }

  // "rate_limits_available" is false for an API key, Bedrock or Vertex session,
  // and "rate_limits" is then null. Leave the last good file alone: a plan quota
  // that does not apply to this session is not news that the quota changed.
  if (document !== null && typeof document === "object") {
    const limits = document.rate_limits;
    if (limits !== null && typeof limits === "object") writeLimits(limits);
  }

  const wrapped = readWrappedCommand();
  if (wrapped !== null) {
    await forward(wrapped, payload);
    return;
  }

  if (document !== null && typeof document === "object") {
    const line = builtInLine(document);
    if (line !== "") process.stdout.write(line + "\n");
  }
}

main().catch(function () {
  // A hook that throws would print a stack trace into the user's status line.
});
