import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Claude Code's statusLine slot is a single command, so this plugin cannot add
 * a second reader beside whatever the user already runs. The installer instead
 * takes the slot and forwards the payload to the command it displaced, which
 * keeps that command's output as the visible status line while the same
 * document lands in the file the `claude-statusline` preset reads.
 *
 * The state is reported rather than assumed: `currentCommand` is whatever
 * settings.json holds right now, which may be the user's own tool, this
 * plugin's hook, or nothing.
 */
export const ClaudeStatusLineStatusSchema = z.object({
  configDir: z.string(),
  settingsPath: z.string(),
  scriptPath: z.string(),
  wrapPath: z.string(),
  limitsPath: z.string(),
  /** True when the statusLine slot holds this plugin's hook. */
  installed: z.boolean(),
  /** The statusLine command settings.json holds now, null when the slot is empty. */
  currentCommand: z.string().nullable(),
  /** The command the hook forwards the payload to, null when there is none. */
  wrappedCommand: z.string().nullable(),
  /** The invocation the installer writes, null when Node is not on PATH. */
  nodeCommand: z.string().nullable(),
  message: z.string().nullable(),
});

export const readClaudeStatusLine = defineRpc({
  name: "usage.claude-statusline.read",
  input: z.object({}),
  output: ClaudeStatusLineStatusSchema,
});

export const installClaudeStatusLine = defineRpc({
  name: "usage.claude-statusline.install",
  input: z.object({}),
  output: ClaudeStatusLineStatusSchema,
});

export const uninstallClaudeStatusLine = defineRpc({
  name: "usage.claude-statusline.uninstall",
  input: z.object({}),
  output: ClaudeStatusLineStatusSchema,
});

export type ClaudeStatusLineStatus = z.infer<typeof ClaudeStatusLineStatusSchema>;
