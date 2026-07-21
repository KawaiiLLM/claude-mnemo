#!/usr/bin/env bash
# turn-detail.sh — structured single-turn detail from the mnemo DB (raw-axis CLI).
#
# Usage:
#   turn-detail.sh <session> <turn> [--cap N | --full] [--no-obs] [--tool NAME]
#
#   <session>   session id, with or without the S prefix (S11231 / 11231)
#   <turn>      prompt_number within the session
#   --cap N     truncate each observation tool_input/tool_result to N chars (N>=1, default 1500)
#   --full      no truncation on observations (conflicts with --cap)
#   --no-obs    omit the observations key entirely
#   --tool NAME only observations whose tool_name matches NAME (SQL LIKE, e.g. 'Bash' or 'mcp__%')
#
# Output: one JSON object on stdout:
#   { "turn": {...meta + user_prompt/assistant_response/assistant_transcript...},
#     "observations": [ {tool_name, status, input_len, result_len, tool_input, tool_result}, ... ] }
# Text fields on the turn are never truncated; lengths are always reported so a
# caller can decide to re-query with --full. Field values are faithful to the DB:
# null means never captured, "" means captured empty (e.g. an interrupted turn).
# Locate turns by DB keys only — transcript_line_start is a best-effort JSONL
# hint and is known to be unreliable.
set -euo pipefail

DB="${MNEMO_DB:-$HOME/.claude-mnemo/claude-mnemo.db}"

die() { echo "turn-detail: $*" >&2; exit 1; }

command -v sqlite3 >/dev/null || die "sqlite3 is required"
command -v jq      >/dev/null || die "jq is required"

[[ $# -ge 2 ]] || die "usage: turn-detail.sh <session> <turn> [--cap N | --full] [--no-obs] [--tool NAME]"
SID="${1#S}"; TURN="$2"; shift 2
CAP=1500; WITH_OBS=1; TOOL_FILTER=""; SEEN_CAP=0; SEEN_FULL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cap)    CAP="${2:?--cap needs a number}"; SEEN_CAP=1; shift 2 ;;
    --full)   SEEN_FULL=1; shift ;;
    --no-obs) WITH_OBS=0; shift ;;
    --tool)   TOOL_FILTER="${2:?--tool needs a name}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$SID"  =~ ^[0-9]+$ ]] || die "session must be numeric (got: $SID)"
[[ "$TURN" =~ ^[0-9]+$ ]] || die "turn must be numeric (got: $TURN)"
[[ "$SEEN_CAP" -eq 1 && "$SEEN_FULL" -eq 1 ]] && die "--cap and --full conflict; pass one"
if [[ "$SEEN_CAP" -eq 1 ]]; then
  [[ "$CAP" =~ ^[0-9]+$ && "$CAP" -ge 1 ]] || die "--cap must be an integer >= 1 (got: $CAP); use --full for no limit"
fi
[[ "$SEEN_FULL" -eq 1 ]] && CAP=0
[[ -r "$DB" ]] || die "DB not readable: $DB"

Q() { sqlite3 -readonly -json -cmd '.timeout 2000' "$DB" "$1"; }

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT

Q "
  SELECT id, prompt_number, status, type, title, tags, significance_grade,
         was_interrupted, was_rolled_back, tool_call_count,
         datetime(created_at_epoch, 'unixepoch', 'localtime') AS created_at,
         length(user_prompt)          AS user_prompt_len,
         length(assistant_response)   AS assistant_response_len,
         length(assistant_transcript) AS assistant_transcript_len,
         user_prompt, assistant_response, assistant_transcript, content, insight
  FROM turns WHERE session_id=$SID AND prompt_number=$TURN;" > "$TMPD/turn.json"
[[ -s "$TMPD/turn.json" ]] || die "no turn: session $SID, prompt_number $TURN"

if [[ "$WITH_OBS" -eq 0 ]]; then
  jq --slurpfile t "$TMPD/turn.json" -n '{turn: $t[0][0]}'
  exit 0
fi

TURN_ID=$(jq -r '.[0].id' "$TMPD/turn.json")

if [[ "$CAP" -gt 0 ]]; then
  IO_COLS="substr(tool_input,1,$CAP) AS tool_input, substr(tool_result,1,$CAP) AS tool_result"
else
  IO_COLS="tool_input, tool_result"
fi
TOOL_WHERE=""
[[ -n "$TOOL_FILTER" ]] && TOOL_WHERE="AND tool_name LIKE '$(echo "$TOOL_FILTER" | sed "s/'/''/g")'"
Q "
  SELECT id, tool_name, status,
         length(tool_input)  AS input_len,
         length(tool_result) AS result_len,
         $IO_COLS
  FROM observations WHERE turn_id=$TURN_ID $TOOL_WHERE ORDER BY id;" > "$TMPD/obs.json"

jq --slurpfile t "$TMPD/turn.json" --slurpfile o "$TMPD/obs.json" -n \
  '{turn: $t[0][0], observations: ($o[0] // [])}'
