// PostToolUse hook, matcher "Write|Edit". Ships a memory note to the aggregator the
// moment it is written.
//
// Why here rather than at SessionEnd: SessionEnd is capped at 1.5s, is killed at
// teardown, and does not fire at all on /clear, on a crash, or on Ctrl-C. PostToolUse
// fires on the write itself, so nothing depends on how the session happens to end.
//
// Why an HTTP POST rather than git: pushing needs a credential that can write to the
// repository, that whoever issued it controls, and that expires on its own schedule —
// so the pipeline stops weeks before anyone notices. On a LAN this endpoint needs no
// credential at all. Off the LAN it needs one, and the difference that matters is that
// this one can only append to an inbox a filter and a human then gate, the tech lead
// revokes it, and when it is missing the notes spool instead of disappearing.
//
// This hook must never break a session. Every failure path exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const SPOOL = path.join(os.homedir(), '.agent-knowledge-spool');
const LOG = path.join(os.tmpdir(), 'agent-knowledge-hook.log');
const TIMEOUT_MS = 2000;

// Which writes are memory notes.
//
// Matching a literal `memory` path segment looks fine and is a trap: autoMemoryDirectory
// can be set anywhere, and the value this project recommends — ~/agent-knowledge/<repo> —
// contains no such segment. A hook keyed on the segment would match nothing under the
// recommended configuration and ship nothing, on the hot path, with no log line. So the
// root is configuration, and the default auto-memory layout is only the fallback.
// `/c/Users/x` is what a POSIX shell on Windows calls `C:\Users\x`, and node does not know that:
// path.resolve turns it into `C:\c\Users\x`, which matches no memory root, so the note exits down
// the fast path with no log line at all. The shell sender already folded this shape and this one did
// not, which made the two senders unequal on exactly the platform that has both.
//
// Only on Windows. On Linux `/c/foo` is an ordinary absolute path and folding it would invent a
// drive letter, breaking the common case to fix a case that cannot occur there.
const WIN = process.platform === 'win32';
const foldDrive = s => (WIN ? String(s).replace(/^\/([A-Za-z])\//, '$1:/') : String(s));
const norm = p => path.resolve(foldDrive(expand(String(p)))).replace(/\\/g, '/').toLowerCase();
function expand(p) { return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

// The root is read from `autoMemoryDirectory`, the same key Claude Code itself uses to
// decide where notes live. Requiring the team to repeat that path in a second variable
// invites configuring one and forgetting the other, which leaves the pipeline dead and
// silent — the failure this whole file is written to avoid.
function settingsRoot(startDir) {
  // Walk up from wherever the session was opened, the way CLAUDE.md files are found. A
  // member who opens Claude in a subdirectory would otherwise land on no project
  // settings at all, so autoMemoryDirectory would not be found and every note would
  // exit silently — the same failure as the old literal-`memory` match, reached by
  // another route. Walking up means the rule "always open from the repo root" does not
  // have to exist, and nothing depends on CLAUDE_PROJECT_DIR being set.
  const files = [];
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24; i++) {
    files.push(path.join(dir, '.claude', 'settings.local.json'));
    files.push(path.join(dir, '.claude', 'settings.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  files.push(path.join(os.homedir(), '.claude', 'settings.json'));

  for (const f of files) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).autoMemoryDirectory;
      if (v && String(v).trim()) return norm(String(v).trim());
    } catch { /* absent or unparseable: try the next one */ }
  }
  return null;
}

const DEFAULT_ROOT = norm(path.join(os.homedir(), '.claude', 'projects'));
const isUnder = (f, r) => r && (f === r || f.startsWith(r.endsWith('/') ? r : r + '/'));

function underRoot(file, cwd) {
  const f = norm(file);
  // Cheap first, and it covers the default install with no I/O at all.
  if (isUnder(f, DEFAULT_ROOT)) return DEFAULT_ROOT;
  const env = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  if (env && env.trim() && isUnder(f, norm(env.trim()))) return norm(env.trim());
  // Anything still here is either an ordinary edit inside the project — by far the
  // common case, and it exits below without touching disk — or a custom memory root.
  if (isUnder(f, norm(cwd)) || !f.endsWith('.md')) return null;
  const cfg = settingsRoot(cwd);
  return isUnder(f, cfg) ? cfg : null;
}

const log = m => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
const done = () => process.exit(0);

// Spooled as a `.head` + `.body` pair rather than as JSON, so that either flusher can drain
// a spool written by either sender. The shell implementation cannot read JSON, and a spool
// only one runtime understands is a spool that never empties on the machines that need it
// most — silent, permanent loss of exactly the notes this design exists to keep.
function spool(note, why) {
  try {
    fs.mkdirSync(SPOOL, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(path.join(SPOOL, `${id}.body`), note.content, 'utf8');
    fs.writeFileSync(path.join(SPOOL, `${id}.head`), headerLines(note).join('\n') + '\n', 'utf8');
    log(`spooled ${id} (${why})`);
  } catch (e) {
    log(`spool failed: ${String(e.message).slice(0, 160)}`);
  }
}

// The note is the request body; everything else travels in headers. The shell
// implementation has to produce the same request without a JSON library, and wrapping a
// multi-kilobyte note full of quotes, newlines and Windows backslashes in JSON is exactly
// where shell breaks. One wire format, and it is the one that needs no escaping.
//
// Base64 for anything that can hold non-ASCII: header values are Latin-1, so a note named
// `ghi-chú-bẫy.md` throws here rather than merely being skipped.
const b64 = v => Buffer.from(String(v == null ? '' : v), 'utf8').toString('base64');

function headerLines(note) {
  return [
    `X-Note-Path-B64: ${b64(note.file_path)}`,
    `X-Memory-Root-B64: ${b64(note.memory_root)}`,
    `X-Identity-Key: ${note.identity_key}`,
    `X-Identity-Label-B64: ${b64(note.identity_label)}`,
    `X-Identity-Source: ${note.identity_source}`,
    `X-Session-Id: ${note.session_id || ''}`,
    `X-Note-Ts: ${note.ts}`,
    `X-Note-Tool: ${note.tool || ''}`,
    // Which project this note belongs to, so one host can serve several. Committed with the repo
    // and not a secret. Deliberately absent from this list: the credential — see credential().
    `X-Project: ${note.project || ''}`,
  ];
}

// Read from `.claude/agent-knowledge.env` in the project, which is gitignored, and never written
// into the spool. A spooled note is a file sitting on disk possibly for days; putting the token in
// its replayable header block would turn every unsent note into a second copy of the credential.
// The flushers read this the same way at send time.
// Reads the member's local settings: the credential, and optionally the endpoint.
//
// The endpoint normally lives in the project's committed `.claude/settings.json`, where it is not a
// secret and saves every member a step. That stops being free when the repository is public: the
// address of a write endpoint on somebody's small VM does not belong in a public git history. So it
// can live here instead, in the file each member already copies once, and the committed settings can
// carry nothing but the project id. Environment wins, then this file — so a team with a private repo
// keeps the simpler arrangement and changes nothing.
function localSettings(startDir) {
  let user = process.env.AGENT_KNOWLEDGE_USER || '';
  let token = process.env.AGENT_KNOWLEDGE_TOKEN || '';
  let ingest = process.env.AGENT_KNOWLEDGE_INGEST || '';

  // Walks up for the same reason the settings lookup does: a member who opens Claude in a
  // subdirectory would otherwise have no credential and no idea why, which is the silent-failure
  // shape this project keeps re-learning.
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24 && (!user || !token || !ingest); i++) {
    const f = path.join(dir, '.claude', 'agent-knowledge.env');
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = /^\s*(AGENT_KNOWLEDGE_USER|AGENT_KNOWLEDGE_TOKEN|AGENT_KNOWLEDGE_INGEST)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || !m[2]) continue;
        if (m[1].endsWith('USER')) user = user || m[2];
        else if (m[1].endsWith('TOKEN')) token = token || m[2];
        else ingest = ingest || m[2];
      }
    } catch { /* absent: keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  return {
    ingest,
    auth: (user && token)
      ? 'Basic ' + Buffer.from(`${user}:${token}`, 'utf8').toString('base64')
      : null,
  };
}

function post(url, note, onFail, auth) {
  let u;
  try { u = new URL(url); } catch { return onFail('bad ingest url'); }
  const body = Buffer.from(note.content, 'utf8');
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request(u, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': body.length },
      auth ? { Authorization: auth } : {},
      // Same lines the spool stores, so a spooled note replays as the identical request.
      headerLines(note).reduce((h, line) => {
        const i = line.indexOf(': ');
        h[line.slice(0, i)] = line.slice(i + 2);
        return h;
      }, {})
    ),
    timeout: TIMEOUT_MS,
  }, res => {
    res.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) { log(`sent ${note.file_path} (${body.length} bytes)`); done(); }
    // 401 and 403 are the machine's problem, not the note's: a missing env file, a token not yet
    // issued, a credential just revoked. Those get fixed, and a note dropped meanwhile is gone for
    // good — so spool it. Every other 4xx is a judgement about this note, which retrying cannot
    // change, so drop it and say why.
    // 403 means the endpoint authenticated the credential and still refuses: the project id in
    // .claude/settings.json is not one this member is on. No retry can fix that, and retrying it is
    // what made the spool grow without bound, so drop it — but say so loudly, because unlike an
    // unacceptable note this is a configuration error somebody has to go and correct.
    else if (res.statusCode === 403) {
      log(`NOT SENT: 403 from ingest — AGENT_KNOWLEDGE_PROJECT is wrong for this credential. ` +
          `Dropping ${path.basename(note.file_path)}; fix .claude/settings.json.`);
      done();
    }
    else if (res.statusCode === 401 || res.statusCode === 429) {
      onFail(`ingest returned ${res.statusCode} — check .claude/agent-knowledge.env`);
    }
    else if (res.statusCode >= 400 && res.statusCode < 500) { log(`refused ${res.statusCode} by ingest, dropping`); done(); }
    else onFail(`ingest returned ${res.statusCode}`);
  });
  req.on('timeout', () => { req.destroy(); onFail('timeout'); });
  req.on('error', e => onFail(String(e.message).slice(0, 120)));
  req.end(body);
}

// A malformed payload must leave a trace. Swallowing it silently means a change in
// the hook input format would switch the whole pipeline off with every log line clean.
let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  log(`NOT SENT: unreadable hook payload on stdin (${String(e.message).slice(0, 100)})`);
  done();
}

// Folded here, once, rather than inside norm(). norm() is only used for comparison, but this value
// is also handed to fs.readFileSync and to two directory walks that call path.resolve themselves —
// and path.resolve turns `/c/Users/x` into `C:\c\Users\x`, which exists nowhere. Folding at the
// comparison alone was the first attempt at this fix and it changed nothing, because every path
// that mattered had already been resolved wrongly by then.
const file = foldDrive(payload?.tool_input?.file_path);
// The common case by far is an ordinary source edit, so this stays a prefix comparison
// with no I/O. It is deliberately the one silent exit in this script: logging every
// source edit would bury the lines that matter.
// Resolved together with the credential, because both can live in the same local file — see
// localSettings(). Read after `cwd` is known, so the walk starts where the session was opened.

// Anchor on the project root, not on where the session happened to start. Claude Code
// supplies CLAUDE_PROJECT_DIR; `payload.cwd` is whichever directory the member opened,
// which may be a subdirectory. Resolving `.claude/settings.json` from a subdirectory
// finds nothing, so autoMemoryDirectory would not be found and every note would exit
// silently — the same failure as the old literal-`memory` match, reached by a different
// route. Using the project root removes the "always open Claude from the repo root"
// rule instead of asking people to remember it.
const cwd = foldDrive(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());

if (!file) done();
const memoryRoot = underRoot(file, cwd);
if (!memoryRoot) done();

// Identity decides whether a second report counts as a second person, so an
// unattributable note is not sent at all. Losing one note is cheap; corrupting the
// contributor count is not.
// Two very different failures hide behind an empty result here, and conflating them
// once cost a whole test run: a member who simply has no user.email configured, and a
// cwd git cannot even be run in. The second one disables the pipeline for every note
// on that machine, so it must not look like the first.
// Identity. The Claude account is the primary source, not git: it is always present,
// because the agent that wrote the note could not have run without a logged-in account,
// whereas `git config user.email` is frequently unset on a fresh machine and is
// sometimes a shared CI address.
//
// The counting key is the account UUID rather than the address, so a member who changes
// their email keeps one identity.
//
// Mixing sources is the danger here, not missing one. If the same person is sometimes
// keyed by their Claude account and sometimes by their git address, they count as two
// people and entries promote themselves — the exact failure the promotion rule exists to
// prevent. Hence one primary that is effectively always available, with git kept only
// for the case where the account file cannot be read at all.
function claudeIdentity() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const a = j.oauthAccount || {};
    const key = a.accountUuid || j.userID;
    if (key) return { key: String(key), label: a.emailAddress ? String(a.emailAddress) : String(key), source: 'claude-account' };
  } catch { /* fall through to git */ }
  return null;
}
function gitIdentity() {
  try {
    const e = execSync('git config --get user.email', { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
    return e ? { key: e, label: e, source: 'git-email' } : null;
  } catch (e) {
    // `git config --get` exits 1 for a key that is simply unset, which is one person
    // filling in their config — not the same as git being unusable here. Reporting the
    // former as the latter sends whoever reads this log hunting the wrong problem.
    if (e.status === 1 && fs.existsSync(cwd)) log(`git user.email is not configured for ${cwd}`);
    else log(fs.existsSync(cwd) ? `git unusable in ${cwd}: ${String(e.message).slice(0, 100)}` : `cwd does not exist: ${cwd}`);
    return null;
  }
}

const identity = claudeIdentity() || gitIdentity();
if (!identity) {
  log(`NOT SENT: no Claude account in ~/.claude.json and no git user.email — cannot attribute ${path.basename(file)}`);
  done();
}

// Always read the note from disk, never from the payload. It makes Write and Edit
// identical — Edit only carries the replaced fragment — it keeps this implementation
// byte-for-byte interchangeable with the shell one, and the file on disk carries the
// frontmatter Claude Code adds after the write, which the payload does not.
let content;
try { content = fs.readFileSync(file, 'utf8'); } catch { log(`NOT SENT: cannot read ${file}`); done(); }
if (!content.trim()) { log(`NOT SENT: ${path.basename(file)} is empty on disk`); done(); }

const note = {
  file_path: file,
  content,
  // key counts, label reads, source lets the endpoint spot a member arriving under two
  // different keys — which would silently inflate the contributor count.
  identity_key: identity.key,
  identity_label: identity.label,
  identity_source: identity.source,
  session_id: payload.session_id || null,
  ts: new Date().toISOString(),
  tool: payload.tool_name || null,
  // The root this matched against. The endpoint cannot know where each member keeps
  // their notes, so it checks the note against the root the sender claims rather than
  // against a path shape of its own.
  memory_root: memoryRoot,
  project: process.env.AGENT_KNOWLEDGE_PROJECT || '',
};

const local = localSettings(cwd);
if (!local.ingest) {
  spool(note, 'no endpoint — set AGENT_KNOWLEDGE_INGEST in .claude/settings.json or in .claude/agent-knowledge.env');
  done();
}

// A member who has not copied the env file yet is not an error to swallow: their notes spool and
// the log says exactly which file to create, so the knowledge waits instead of evaporating.
const auth = local.auth;
if (!auth) {
  spool(note, 'no credential — copy hooks/agent-knowledge.env.sample to .claude/agent-knowledge.env');
  done();
}

post(local.ingest.replace(/\/$/, '') + '/note', note, why => { spool(note, why); done(); }, auth);
