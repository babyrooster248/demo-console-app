// SessionStart hook. Resends notes that could not reach the aggregator earlier — the member
// was offline, off the VPN, or the endpoint was down.
//
// Nothing here depends on the member doing anything: a note that failed to send is retried at
// the start of every session until it lands, and only then deleted.
//
// Spool entries are a `.head` + `.body` pair, the same shape flush-spool.sh reads and both
// senders write. A spool only one runtime understands is a spool that never empties on the
// machines that need it most.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const SPOOL = path.join(os.homedir(), '.agent-knowledge-spool');
const LOG = path.join(os.tmpdir(), 'agent-knowledge-hook.log');
const TIMEOUT_MS = 3000;
const MAX_PER_RUN = 25;

const log = m => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [flush] ${m}\n`); } catch {} };

if (!fs.existsSync(SPOOL)) process.exit(0);

// Bound the spool. 403 now covers the wrong-project case, but other permanent failures do not
// announce themselves — an endpoint URL that is wrong for good just refuses the connection every
// time — and the spool would grow until the disk noticed. Deliberately large and deliberately loud:
// every discard is a note nobody will ever read, so it is worth a line saying which one and why.
//
// Pruned before the credential check, not after. A member who never copies the env file is the
// longest-lived version of this state, and exiting early would mean never pruning at all.
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;
try {
  const heads = fs.readdirSync(SPOOL).filter(f => f.endsWith('.head'))
    .map(f => {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(SPOOL, f)).mtimeMs; } catch {}
      return { f, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const doomed = heads.filter(h => h.mtime && h.mtime < cutoff);
  const excess = heads.slice(0, Math.max(0, heads.length - MAX_ENTRIES));
  for (const h of new Set([...doomed, ...excess])) {
    const id = h.f.replace(/\.head$/, '');
    const days = h.mtime ? Math.round((Date.now() - h.mtime) / 86400000) : '?';
    fs.rmSync(path.join(SPOOL, h.f), { force: true });
    fs.rmSync(path.join(SPOOL, `${id}.body`), { force: true });
    log(`DISCARDED ${id} — undelivered for ${days} day(s), spool held ${heads.length} entries ` +
        `(limits: ${MAX_ENTRIES} entries, ${MAX_AGE_DAYS} days). The endpoint has been unreachable ` +
        `or refusing for a long time; this note is lost.`);
  }
} catch (e) { log(`spool prune failed: ${String(e.message).slice(0, 120)}`); }

// The credential is read here rather than replayed from the spool, because the spool deliberately
// does not hold it. The endpoint is read the same way, so a public repository can commit nothing but
// the project id and keep the host's address out of git history. Walks up from the session directory
// for the same reason the sender does.
function localSettings(startDir) {
  let user = process.env.AGENT_KNOWLEDGE_USER || '';
  let token = process.env.AGENT_KNOWLEDGE_TOKEN || '';
  let ingest = process.env.AGENT_KNOWLEDGE_INGEST || '';
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24 && (!user || !token || !ingest); i++) {
    try {
      for (const line of fs.readFileSync(path.join(dir, '.claude', 'agent-knowledge.env'), 'utf8').split('\n')) {
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

// No credential means the notes stay spooled. Exiting here rather than sending is the difference
// between "waiting for a one-time setup step" and "every queued note burned on a 401".
const LOCAL = localSettings(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const ingest = LOCAL.ingest;
const AUTH = LOCAL.auth;
if (!ingest) process.exit(0);
if (!AUTH) {
  log('no credential — leaving spool untouched; copy hooks/agent-knowledge.env.sample to .claude/agent-knowledge.env');
  process.exit(0);
}

const ids = fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')).sort().slice(0, MAX_PER_RUN)
  .map(f => f.replace(/\.head$/, ''));
if (!ids.length) process.exit(0);

const url = ingest.replace(/\/$/, '') + '/note';

function send(id) {
  return new Promise(resolve => {
    const headFile = path.join(SPOOL, `${id}.head`);
    const bodyFile = path.join(SPOOL, `${id}.body`);
    const drop = () => { fs.rmSync(headFile, { force: true }); fs.rmSync(bodyFile, { force: true }); };

    if (!fs.existsSync(bodyFile)) { drop(); return resolve(`${id}: no body, discarded`); }

    let headers, body;
    try {
      headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
      for (const line of fs.readFileSync(headFile, 'utf8').split('\n')) {
        const i = line.indexOf(': ');
        if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2).trim();
      }
      body = fs.readFileSync(bodyFile);
    } catch { drop(); return resolve(`${id}: unreadable, discarded`); }
    headers['Content-Length'] = body.length;
    headers.Authorization = AUTH;

    let u;
    try { u = new URL(url); } catch { return resolve(`${id}: bad ingest url`); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers, timeout: TIMEOUT_MS }, res => {
      res.resume();
      const code = res.statusCode;
      // 401 and 403 must be kept. Before authentication existed, every 4xx meant "this note is
      // unacceptable and always will be", so discarding was right. Now the commonest 4xx is a
      // credential problem — not yet issued, mistyped, revoked and reissued — and discarding on it
      // would burn the entire spool over a config error, which is the most destructive thing this
      // hook could do. Everything else in the 4xx range is still a verdict on the note itself.
      // 403 is authenticated-and-forbidden: the project id will never be right for this credential,
      // so keeping the entry means keeping it for ever. Dropped, loudly.
      if (code === 403) {
        drop();
        return resolve(`${id}: DISCARDED (403 — AGENT_KNOWLEDGE_PROJECT wrong for this credential)`);
      }
      if (code === 401) return resolve(`${id}: kept (401, check credential)`);
      // 429 likewise: a rate limit exists to delay knowledge, never to destroy it. A flusher that
      // discarded on it would empty the spool precisely when the endpoint asked it to slow down.
      if (code === 429) return resolve(`${id}: kept (429 rate limited)`);
      if ((code >= 200 && code < 300) || (code >= 400 && code < 500)) {
        drop();
        resolve(`${id}: ${code >= 300 ? 'refused ' + code + ', discarded' : 'delivered'}`);
      } else resolve(`${id}: kept (ingest returned ${code})`);
    });
    req.on('timeout', () => { req.destroy(); resolve(`${id}: kept (timeout)`); });
    req.on('error', e => resolve(`${id}: kept (${String(e.message).slice(0, 60)})`));
    req.end(body);
  });
}

(async () => {
  const results = [];
  for (const id of ids) results.push(await send(id));
  const left = fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')).length : 0;
  log(`${ids.length} attempted, ${left} still queued`);
  for (const r of results) log('  ' + r);
  process.exit(0);
})();
