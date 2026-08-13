#!/bin/sh
# Invoked as `sh hooks/post-note.sh`, not bash. The script uses no bash-only feature, and
# Alpine — no bash at all, busybox everything — runs it unchanged, which is the case that
# proved `bash` in the hook command was narrower than necessary. Every system with a POSIX
# shell has `sh`; not every one has `bash`.
# PostToolUse hook, matcher "Write|Edit". Same job as post-note.js, in plain shell.
#
# Why both exist: Claude Code never runs on node — even the npm package just downloads a
# native binary — so node is not implied on any platform. A POSIX shell is not implied
# either: native Windows without Git for Windows has none. Neither runtime is universal,
# so both hooks are registered and whichever one the machine can run does the work. A hook
# whose runtime is missing fails silently and does not block the other (measured), and when
# both run the endpoint's dedupe collapses the duplicate (also measured).
#
# Needs only bash and curl. curl ships in System32 on Windows 10+, and is standard on
# macOS and Linux.

set -u
LOG="${TMPDIR:-/tmp}/agent-knowledge-hook.log"
SPOOL="$HOME/.agent-knowledge-spool"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

# Path shapes are the trap here, and they cost three debugging rounds before this comment
# existed. On Windows the same directory shows up as `C:\Users\x` in the hook payload, as
# `C:/Users/x` once backslashes are converted, and as `/c/Users/x` from $HOME under Git
# Bash. Comparing any two of those as plain strings quietly fails, and a quiet failure here
# means every note is dropped. Everything is folded to one shape before comparison:
# forward slashes, drive letter as `c:/`, lower case, no trailing slash.
#
# The drive fold applies on Windows only. On Linux `/c/foo` is an ordinary absolute path, and
# folding it there would invent a drive letter and break the common case to fix one that cannot
# happen. Detected from the environment rather than by calling `uname`, because this runs on every
# Write and Edit and a subprocess per invocation is a real cost for a constant.
if [ -n "${WINDIR:-}${SYSTEMROOT:-}" ]; then IS_WIN=1; else IS_WIN=0; fi

norm() {
  p="$(printf '%s' "$1" | tr '\\' '/')"
  if [ "$IS_WIN" = 1 ]; then
    case "$p" in
      /[A-Za-z]/*) p="$(printf '%s' "$p" | sed 's#^/\([A-Za-z]\)/#\1:/#')" ;;
    esac
  fi
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]' | sed 's#/*$##'
}

payload="$(cat)"
[ -n "$payload" ] || { log "NOT SENT: empty hook payload on stdin"; exit 0; }

# One field is extracted, and only one: the path that was written. Everything else either
# comes from a file we can read directly or from a header we set ourselves.
# Extended regex, not basic. `\(...\|...\)` is a GNU extension that BSD grep — which is what
# macOS ships — does not understand, and it would fail there while working perfectly here.
# ERE alternation is portable, and these two lines were the script's only GNU dependency.
file="$(printf '%s' "$payload" \
  | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"(\\.|[^"\\])*"' \
  | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//' | sed 's/\\\\/\\/g')"
[ -n "$file" ] || exit 0

cwd="$(printf '%s' "$payload" \
  | grep -oE '"cwd"[[:space:]]*:[[:space:]]*"(\\.|[^"\\])*"' \
  | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//' | sed 's/\\\\/\\/g')"
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && cwd="$CLAUDE_PROJECT_DIR"
[ -n "$cwd" ] || cwd="$PWD"

# Where notes live. Read from autoMemoryDirectory — the same key Claude Code uses — walking
# up from the session directory, so opening Claude in a subdirectory still works and no
# second copy of the path has to be kept in sync.
expand_tilde() { case "$1" in "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }
read_setting() {
  grep -o '"autoMemoryDirectory"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null \
    | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}
root=""
dir="$(printf '%s' "$cwd" | tr '\\' '/')"
for _ in $(seq 1 24); do
  for f in "$dir/.claude/settings.local.json" "$dir/.claude/settings.json"; do
    [ -f "$f" ] || continue
    v="$(read_setting "$f")"
    [ -n "$v" ] && { root="$(expand_tilde "$v")"; break; }
  done
  [ -n "$root" ] && break
  parent="${dir%/*}"
  [ "$parent" = "$dir" ] && break
  [ -z "$parent" ] && break
  dir="$parent"
done
if [ -z "$root" ]; then
  v="$(read_setting "$HOME/.claude/settings.json")"
  [ -n "$v" ] && root="$(expand_tilde "$v")"
fi
default_root="$HOME/.claude/projects"

# The hot path: every ordinary source edit reaches here and leaves without touching disk
# or spawning anything. It is deliberately the one silent exit — logging every edit would
# bury the lines that matter.
nfile="$(norm "$file")"
matched=""
for candidate in "$root" "$default_root"; do
  [ -n "$candidate" ] || continue
  nc="$(norm "$candidate")"
  # The normalised form is what goes on the wire too, so the endpoint compares two paths
  # in the same shape no matter which implementation sent them.
  case "$nfile" in "$nc"/*) matched="$nc"; break ;; esac
done
[ -n "$matched" ] || exit 0

# A personal index of one member's own notes, not knowledge. Refused by the endpoint too,
# but there is no reason to send it.
case "$(basename "$nfile")" in memory.md) exit 0 ;; esac

# Identity. The Claude account is the primary source because the agent could not have
# written the note without being logged in, whereas git user.email is often unset on a
# fresh machine and is sometimes a shared CI address. The counting key is the account
# UUID, so changing an address keeps one identity. Mixing the two sources is the real
# hazard: one person keyed two ways counts as two people and can confirm their own line.
jsonf="$HOME/.claude.json"
key=""; label=""; source=""
if [ -f "$jsonf" ]; then
  key="$(grep -o '"accountUuid"[[:space:]]*:[[:space:]]*"[^"]*"' "$jsonf" | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  label="$(grep -o '"emailAddress"[[:space:]]*:[[:space:]]*"[^"]*"' "$jsonf" | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  [ -n "$key" ] && source="claude-account"
fi
if [ -z "$key" ]; then
  if key="$(git -C "$cwd" config --get user.email 2>/dev/null)" && [ -n "$key" ]; then
    label="$key"; source="git-email"
  else
    log "NOT SENT: no Claude account in ~/.claude.json and no git user.email — cannot attribute $(basename "$file")"
    exit 0
  fi
fi
[ -n "$label" ] || label="$key"

# Read the note from disk rather than out of the payload. It makes Write and Edit identical
# — Edit only carries the replaced fragment — and the file on disk also has the frontmatter
# Claude Code adds after the write, which the payload does not.
[ -r "$file" ] || { log "NOT SENT: cannot read $file"; exit 0; }

session="$(printf '%s' "$payload" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Header values are Latin-1, so anything that can hold non-ASCII travels base64. A note
# named `ghi-chú-bẫy.md` is enough to break a plain header — it took down the node
# implementation outright and made this one send bytes the endpoint could not reconstruct.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

spool_it() {
  mkdir -p "$SPOOL" 2>/dev/null || { log "spool failed: cannot create $SPOOL"; return; }
  id="$(date +%s)-$$"
  cp "$file" "$SPOOL/$id.body" 2>/dev/null || { log "spool failed: cannot copy note"; return; }
  {
    printf 'X-Note-Path-B64: %s\n' "$(b64 "$file")"
    printf 'X-Memory-Root-B64: %s\n' "$(b64 "$matched")"
    printf 'X-Identity-Key: %s\n' "$key"
    printf 'X-Identity-Label-B64: %s\n' "$(b64 "$label")"
    printf 'X-Identity-Source: %s\n' "$source"
    printf 'X-Session-Id: %s\n' "$session"
    printf 'X-Note-Ts: %s\n' "$ts"
    printf 'X-Note-Tool: %s\n' "shell"
    printf 'X-Project: %s\n' "${AGENT_KNOWLEDGE_PROJECT:-}"
  } > "$SPOOL/$id.head"
  log "spooled $id ($1)"
}

# Resolved below, alongside the credential: both may live in .claude/agent-knowledge.env, so a public
# repository can commit the project id and nothing else. The address of a write endpoint on somebody's
# small VM does not belong in a public git history.
ingest="${AGENT_KNOWLEDGE_INGEST:-}"

# The credential, read from `.claude/agent-knowledge.env` walking up from the session directory —
# same walk as the settings lookup, so opening Claude in a subdirectory still finds it. Never
# written into the spool: an unsent note can sit on disk for days, and putting the token in its
# replayable header block would make every one of them a second copy of the credential.
ak_user="${AGENT_KNOWLEDGE_USER:-}"
ak_token="${AGENT_KNOWLEDGE_TOKEN:-}"
d="$cwd"
i=0
while [ "$i" -lt 24 ]; do
  f="$d/.claude/agent-knowledge.env"
  if [ -f "$f" ]; then
    [ -n "$ak_user" ] || ak_user="$(sed -n 's/^[[:space:]]*AGENT_KNOWLEDGE_USER[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$f" | tr -d '\r' | head -1)"
    [ -n "$ak_token" ] || ak_token="$(sed -n 's/^[[:space:]]*AGENT_KNOWLEDGE_TOKEN[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$f" | tr -d '\r' | head -1)"
    [ -n "$ingest" ] || ingest="$(sed -n 's/^[[:space:]]*AGENT_KNOWLEDGE_INGEST[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$f" | tr -d '\r' | head -1)"
  fi
  [ -n "$ak_user" ] && [ -n "$ak_token" ] && [ -n "$ingest" ] && break
  up="$(dirname "$d")"
  [ "$up" = "$d" ] && break
  d="$up"
  i=$((i + 1))
done

if [ -z "$ingest" ]; then
  spool_it "no endpoint — set AGENT_KNOWLEDGE_INGEST in .claude/settings.json or .claude/agent-knowledge.env"
  exit 0
fi
ingest="${ingest%/}"

if [ -z "$ak_user" ] || [ -z "$ak_token" ]; then
  spool_it "no credential — copy hooks/agent-knowledge.env.sample to .claude/agent-knowledge.env"
  exit 0
fi
# `printf | base64` rather than `base64 <<<`: no herestring in POSIX sh, and -w0 is GNU-only.
auth="Basic $(printf '%s:%s' "$ak_user" "$ak_token" | base64 | tr -d '\n\r')"

# The note is piped in rather than handed to curl as `@filename`. On Windows the shell can
# open a file whose name has diacritics but curl cannot: it receives the path as UTF-8 bytes
# and asks the OS for it in the active codepage, so `ghi-chú-bẫy.md` fails with no output at
# all. `cat` has no such problem, and piping keeps the filename out of curl's hands entirely.
code="$(cat "$file" | curl -sS -o /dev/null -w '%{http_code}' --max-time 2 -X POST \
  --data-binary @- \
  -H "Content-Type: text/markdown; charset=utf-8" \
  -H "X-Note-Path-B64: $(b64 "$file")" \
  -H "X-Memory-Root-B64: $(b64 "$matched")" \
  -H "X-Identity-Key: $key" \
  -H "X-Identity-Label-B64: $(b64 "$label")" \
  -H "X-Identity-Source: $source" \
  -H "X-Session-Id: $session" \
  -H "X-Note-Ts: $ts" \
  -H "X-Note-Tool: shell" \
  -H "X-Project: ${AGENT_KNOWLEDGE_PROJECT:-}" \
  -H "Authorization: $auth" \
  "$ingest/note" 2>/dev/null)" || code="000"

case "$code" in
  2*) log "sent $file ($(wc -c < "$file" | tr -d ' ') bytes)" ;;
  # 401 and 403 are the machine's problem, not the note's — an env file not copied yet, a token
  # revoked. Those get fixed; a note dropped in the meantime is gone for good, so spool it.
  # 403: authenticated, and the project id is not one this credential is on. No retry fixes a wrong
  # value in a committed settings.json, and retrying it is what made the spool grow for ever.
  403) log "NOT SENT: 403 from ingest — AGENT_KNOWLEDGE_PROJECT is wrong for this credential. Dropping $(basename "$file"); fix .claude/settings.json" ;;
  401) spool_it "http 401 — check .claude/agent-knowledge.env" ;;
  # 429 is the endpoint asking for patience, not a verdict on the note. Dropping here would let a
  # rate limit destroy knowledge, which is the one thing a rate limit must never do.
  429) spool_it "http 429 rate limited" ;;
  # Any other 4xx is a judgement about this note that retrying cannot change.
  4*) log "refused $code by ingest, dropping" ;;
  *)  spool_it "curl http $code" ;;
esac
exit 0
