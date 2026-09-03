#!/usr/bin/env bash
# Claude Code statusline command. It does two things every turn:
#
#   1. writes the `rate_limits` object Claude Code hands it to
#      $CLAUDE_CONFIG_DIR/paseo-rate-limits.json (default ~/.claude), which the
#      usage-limits plugin's `claude-statusline` preset reads;
#   2. prints a status line, because whatever this command prints IS the status
#      line. A command that prints nothing leaves it blank.
#
# The object is written through as-is: the plugin's reading paths are Claude
# Code's own field names, so nothing here reshapes or renames anything.
#
# Install:
#   paseo plugin ... (see README) then, in ~/.claude/settings.json:
#     "statusLine": { "type": "command", "command": "~/.claude/statusline-hook.sh" }
set -uo pipefail

# Claude Code writes one JSON document to stdin and waits for stdout. Read it
# with a timeout so a hung parent cannot wedge the status line forever.
INPUT=""
while IFS= read -r -t 5 line || [ -n "$line" ]; do
    INPUT="${INPUT}${line}
"
done
[ -z "$INPUT" ] && exit 0

printf '%s' "$INPUT" | python3 -c '
import json, os, sys, tempfile

try:
    payload = json.load(sys.stdin)
except ValueError:
    sys.exit(0)

model = (payload.get("model") or {}).get("display_name") or ""
directory = (payload.get("workspace") or {}).get("current_dir") or ""
parts = [part for part in (model, os.path.basename(directory)) if part]

limits = payload.get("rate_limits")
# `rate_limits_available` is false for an API key, Bedrock or Vertex session,
# and `rate_limits` is then null. Leave the last good file alone: a plan quota
# that does not apply to this session is not news that the quota changed.
if isinstance(limits, dict):
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )
    target = os.path.join(config_dir, "paseo-rate-limits.json")
    try:
        os.makedirs(config_dir, exist_ok=True)
        # Written through a temporary file in the same directory and renamed, so
        # a reader never sees half a document.
        handle, staged = tempfile.mkstemp(dir=config_dir, prefix=".paseo-rate-limits-")
        with os.fdopen(handle, "w") as file:
            json.dump(limits, file)
        os.replace(staged, target)
    except OSError:
        # A status line is not the place to report a disk problem. The plugin
        # names the path it could not read instead.
        pass

    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        window = limits.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get("utilization")
        if isinstance(used, (int, float)):
            parts.append(f"{label} {round(used)}%")

print(" · ".join(parts))
'
