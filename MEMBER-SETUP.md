# Joining a project that shares agent knowledge

One file, once. After that nothing asks anything of you again.

```bash
cp hooks/agent-knowledge.env.sample .claude/agent-knowledge.env
```

Open it and fill in the three values your tech lead sends you:

```
AGENT_KNOWLEDGE_USER=you@example.com
AGENT_KNOWLEDGE_TOKEN=<issued once, not recoverable>
AGENT_KNOWLEDGE_INGEST=https://<the team's knowledge host>
```

`.claude/agent-knowledge.env` is gitignored and never leaves your machine.

## Why the endpoint is in this file and not in the repository

It usually is in the repository — `.claude/settings.json` is where it belongs when the repo is
private, and then this line stays blank and you fill in two values instead of three.

This repository is public, and the endpoint is a write endpoint on a small server. Publishing its
address in a git history invites traffic that costs somebody CPU for nothing. So it moves into the
file you were already copying, and the committed configuration carries only the project id, which is
not a secret and is what lets one host serve several teams.

## If you skip this

Nothing breaks and nothing is lost. Your agent still writes its notes; they queue locally and the log
in your temp directory says exactly which file to create. Copy it later and the queue drains at the
start of your next session.

What you do lose until then is the other direction: the shared file in the repo is already there and
already read on every session, so you are receiving the team's knowledge whether or not you have ever
sent any.
