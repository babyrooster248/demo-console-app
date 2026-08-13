#!/bin/sh
# SessionStart hook. Resends notes that could not reach the aggregator earlier — the member
# was offline, off the VPN, or the endpoint was down.
#
# This exists because for a while it did not, and that was a real hole rather than a missing
# nicety: post-note.sh spools, and the only flusher was the Node one. On a machine with a
# shell and no Node — precisely the machine the shell sender exists to serve — notes were
# spooled and then never sent again. Silent and permanent, which is the failure mode this
# whole design is built to avoid.
#
# Both senders spool the same `.head` + `.body` pair, so either flusher drains either spool.

set -u
SPOOL="$HOME/.agent-knowledge-spool"
LOG="${TMPDIR:-/tmp}/agent-knowledge-hook.log"
MAX=25
log() { printf '%s [flush] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

# Resolved with the credential below, because both may live in .claude/agent-knowledge.env. Checked
# after the pruning, so a member who has configured neither still gets their spool bounded.
ingest="${AGENT_KNOWLEDGE_INGEST:-}"
[ -d "$SPOOL" ] || exit 0

# Bound the spool, before the credential check for the same reason the node flusher does: a member
# who never copies the env file is the longest-lived version of this state. Loud on every discard —
# a dropped note is one nobody will ever read.
MAX_ENTRIES=500
MAX_AGE_DAYS=30
prune_one() {
  id="$(basename "$1" .head)"
  rm -f "$1" "${1%.head}.body"
  log "DISCARDED $id — $2. The endpoint has been unreachable or refusing for a long time; this note is lost."
}
# `find -mtime` rather than comparing dates in shell: no arithmetic on timestamps, and it is the one
# spelling that behaves the same on GNU and BSD find.
find "$SPOOL" -name '*.head' -mtime +$MAX_AGE_DAYS 2>/dev/null | while IFS= read -r old; do
  [ -f "$old" ] && prune_one "$old" "undelivered for over $MAX_AGE_DAYS days"
done
count=0
for f in "$SPOOL"/*.head; do [ -f "$f" ] && count=$((count + 1)); done
if [ "$count" -gt "$MAX_ENTRIES" ]; then
  # Oldest first, so the excess dropped is the least likely to still matter.
  ls -1tr "$SPOOL"/*.head 2>/dev/null | head -n $((count - MAX_ENTRIES)) | while IFS= read -r old; do
    [ -f "$old" ] && prune_one "$old" "spool held $count entries, limit $MAX_ENTRIES"
  done
fi

# Read at send time, never replayed from the spool — the spool deliberately holds no credential.
ak_user="${AGENT_KNOWLEDGE_USER:-}"
ak_token="${AGENT_KNOWLEDGE_TOKEN:-}"
d="${CLAUDE_PROJECT_DIR:-$PWD}"
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

[ -n "$ingest" ] || exit 0
ingest="${ingest%/}"

# Leave the spool alone rather than spend it on 401s. Waiting for a setup step is recoverable.
if [ -z "$ak_user" ] || [ -z "$ak_token" ]; then
  log "no credential — leaving spool untouched; copy hooks/agent-knowledge.env.sample to .claude/agent-knowledge.env"
  exit 0
fi
auth="Basic $(printf '%s:%s' "$ak_user" "$ak_token" | base64 | tr -d '\n\r')"

n=0
attempted=0
for head in "$SPOOL"/*.head; do
  [ -f "$head" ] || continue
  n=$((n + 1))
  [ "$n" -gt "$MAX" ] && break
  body="${head%.head}.body"
  id="$(basename "$head" .head)"
  if [ ! -f "$body" ]; then
    rm -f "$head"
    log "$id: no body, discarded"
    continue
  fi

  # POSIX sh has no arrays; `set --` builds the argument list one header at a time. Values
  # are base64 or plain ASCII, so nothing here needs escaping.
  set --
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set -- "$@" -H "$line"
  done < "$head"

  attempted=$((attempted + 1))
  code="$(cat "$body" | curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -X POST \
    --data-binary @- -H "Content-Type: text/markdown; charset=utf-8" \
    -H "Authorization: $auth" "$@" \
    "$ingest/note" 2>/dev/null)" || code="000"

  case "$code" in
    2*) rm -f "$head" "$body"; log "$id: delivered" ;;
    # 401 and 403 are kept. Before auth existed every 4xx meant "unacceptable forever", so
    # discarding was right; now the commonest 4xx is a credential problem, and discarding on it
    # would burn the whole spool over a config error.
    # 403: the project id will never be right for this credential, so keeping it means for ever.
    403) rm -f "$head" "$body"; log "$id: DISCARDED (403 — AGENT_KNOWLEDGE_PROJECT wrong for this credential)" ;;
    401) log "$id: kept (401, check credential)" ;;
    # Kept for the same reason: a rate limit delays knowledge, it does not reject it.
    429) log "$id: kept (429 rate limited)" ;;
    # Any other 4xx is still a verdict on the note itself, which retrying cannot change.
    4*) rm -f "$head" "$body"; log "$id: refused $code, discarded" ;;
    *)  log "$id: kept (http $code)" ;;
  esac
done

left=0
for f in "$SPOOL"/*.head; do [ -f "$f" ] && left=$((left + 1)); done
[ "$attempted" -gt 0 ] && log "$attempted attempted, $left still queued"
exit 0
