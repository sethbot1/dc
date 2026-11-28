// Dueck Clicker server: accounts, cloud saves, leaderboards, analytics and an admin page.
// No npm packages needed. Runs on Node.js 22.13 or newer (it uses the built-in node:sqlite).
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { isBadName } = require("./names.js");

// ---------- config (set these in the .env file next to this script) ----------
loadEnv(process.env.ENV_FILE || path.join(__dirname, ".env"));
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // only the tunnel talks to us, never the open internet
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "dueck.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "data", "backups");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://sethbot1.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",").map(s => s.trim()).filter(Boolean);
const CHANNELS = new Set(["main", "beta"]);
const MAX_SAVE = 4 * 1024 * 1024;
const AUTOCLICK_CPS = 30;

function loadEnv(f) {
  try {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set, so the /admin page is turned off.");

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS players(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL, last_seen INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS saves(
  player_id INTEGER NOT NULL, channel TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY(player_id, channel));
CREATE TABLE IF NOT EXISTS scores(
  player_id INTEGER NOT NULL, channel TEXT NOT NULL, ever REAL NOT NULL DEFAULT 0, best REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0, play REAL NOT NULL DEFAULT 0, asc INTEGER NOT NULL DEFAULT 0, crown REAL NOT NULL DEFAULT 0,
  ach INTEGER NOT NULL DEFAULT 0, cheat INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
  PRIMARY KEY(player_id, channel));
CREATE INDEX IF NOT EXISTS scores_ever ON scores(channel, ever DESC);
CREATE INDEX IF NOT EXISTS scores_best ON scores(channel, best DESC);
CREATE INDEX IF NOT EXISTS scores_clicks ON scores(channel, clicks DESC);
CREATE INDEX IF NOT EXISTS scores_play ON scores(channel, play DESC);
CREATE TABLE IF NOT EXISTS flags(
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL,
  reason TEXT NOT NULL, detail TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, channel TEXT NOT NULL,
  vid TEXT NOT NULL, sid TEXT NOT NULL, type TEXT NOT NULL, name TEXT, secs INTEGER);
CREATE INDEX IF NOT EXISTS events_day ON events(day, channel);
CREATE INDEX IF NOT EXISTS events_sid ON events(sid);
`);
// newer columns, added to older databases on start
if (!db.prepare("PRAGMA table_info(players)").all().some(c => c.name === "tag")) db.exec("ALTER TABLE players ADD COLUMN tag TEXT");
const q = sql => db.prepare(sql);

// ---------- helpers ----------
const now = () => Date.now();
const day = t => new Date(t).toISOString().slice(0, 10);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
const isId = s => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);

function send(res, code, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(code, { "Content-Type": isStr ? "text/html; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
function clientIp(req) {
  // the tunnel adds the real visitor address; it is only used for rate limits and is never stored
  return String(req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();
}
function readBody(req, limit) {
  return new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on("data", c => { size += c.length; if (size > limit) { bad(Object.assign(new Error("too big"), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { bad(Object.assign(new Error("bad json"), { code: 400 })); } });
    req.on("error", bad);
  });
}

// simple in-memory rate limits: [max requests, per this many ms]
const LIMITS = { register: [20, 3600e3], save: [30, 60e3], load: [30, 60e3], event: [240, 60e3], board: [120, 60e3], adminFail: [10, 900e3] };
const hits = new Map();
function limited(kind, key) {
  // if the tunnel didn't pass the visitor's address, everyone looks the same; skip the limit rather than block real players
  if (key === "" || key === "127.0.0.1" || key === "::1" || key === "::ffff:127.0.0.1") return false;
  const [max, win] = LIMITS[kind], k = kind + "|" + key, t = now();
  let h = hits.get(k);
  if (!h || t - h.start > win) { h = { start: t, n: 0 }; hits.set(k, h); }
  return ++h.n > max;
}
setInterval(() => { const t = now(); for (const [k, h] of hits) if (t - h.start > 3600e3) hits.delete(k); }, 600e3).unref();

function auth(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const p = q("SELECT * FROM players WHERE token_hash=?").get(sha(m[1]));
  if (p) q("UPDATE players SET last_seen=? WHERE id=?").run(now(), p.id);
  return p || null;
}

// ---------- names ----------
function cleanName(n) {
  n = String(n || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z0-9 _.-]{3,16}$/.test(n)) return { err: "Names are 3 to 16 letters, numbers, spaces, dots, dashes or underscores." };
  if (isBadName(n)) return { err: "That name isn't allowed. Please pick a different one." };
  return { name: n };
}

// ---------- anti-cheat ----------
// Nothing here ever bans, hides or changes anyone by itself, so it can't punish an innocent player.
// It only writes a note on the admin page, with the innocent explanations next to it, and a person decides.
function stats(save) {
  return {
    ever: num(save.ever != null ? save.ever : save.all), best: num(save.best), clicks: num(save.clicks), play: num(save.play),
    asc: Math.floor(num(save.asc)), crown: num(save.crown), ach: Array.isArray(save.ach) ? save.ach.length : 0, cheat: save.cheat ? 1 : 0,
  };
}
function addFlag(pid, ch, reason, detail) {
  if (q("SELECT 1 FROM flags WHERE player_id=? AND channel=? AND reason=? AND reviewed=0").get(pid, ch, reason)) return;
  q("INSERT INTO flags(player_id,channel,at,reason,detail) VALUES(?,?,?,?,?)").run(pid, ch, now(), reason, detail);
}
function checkSave(pid, ch, save, st, prev) {
  const broken = ["d", "total", "all", "ever", "best", "clicks", "play"].filter(k => save[k] != null && (typeof save[k] !== "number" || !isFinite(save[k]) || save[k] < 0));
  if (broken.length) addFlag(pid, ch, "broken numbers", `These numbers are not normal positive numbers: ${broken.join(", ")}. Could be save editing, or a game bug.`);
  if (!prev) return;
  const dt = (now() - prev.updated) / 1000, dplay = st.play - prev.play, dclicks = st.clicks - prev.clicks;
  // play time only grows while the game is open, at most one second per real second
  if (dt > 0 && dplay > dt + 300) { addFlag(pid, ch, "time travel", `Play time went up ${Math.round(dplay)}s in ${Math.round(dt)}s of real time. Innocent if they imported a save or played on two devices.`); return; }
  // AutoClicker tag. Only taps on the face count as clicks (holding a key doesn't), and the speed is
  // averaged over at least 20 seconds using whichever is LONGER, play time or real time, so it can only
  // come out lower than the truth. Fast humans manage about 15 a second in short bursts; this needs 30+.
  if (dplay >= 20 && dplay <= dt + 60 && dclicks > 0) {
    const cps = dclicks / Math.max(dplay, dt);
    if (cps >= AUTOCLICK_CPS) {
      const p = q("SELECT tag FROM players WHERE id=?").get(pid);
      if (!p.tag) {
        q("UPDATE players SET tag='AutoClicker' WHERE id=?").run(pid);
        addFlag(pid, ch, "AutoClicker tag", `Tagged automatically: ${Math.round(cps)} clicks per second averaged over ${Math.round(Math.max(dplay, dt))}s. Remove the tag here if it's wrong.`);
      }
    }
  }
}

// ---------- routes ----------
const routes = {
  "GET /api/health": () => ({ ok: true, time: now() }),
  "GET /api/time": () => ({ time: now() }),

  async "POST /api/register"(req) {
    if (limited("register", clientIp(req))) return [429, { error: "Too many new accounts from here. Try again later." }];
    const b = await readBody(req, 4096);
    const c = cleanName(b.name);
    if (c.err) return [400, { error: c.err }];
    if (q("SELECT 1 FROM players WHERE name=?").get(c.name)) return [409, { error: "That name is taken." }];
    const token = crypto.randomBytes(32).toString("base64url");
    q("INSERT INTO players(name,token_hash,created,last_seen) VALUES(?,?,?,?)").run(c.name, sha(token), now(), now());
    return { name: c.name, token };
  },

  "GET /api/me"(req) {
    const p = auth(req);
    if (!p) return [401, { error: "Not signed in." }];
    return { name: p.name, tag: p.tag || null, banned: !!p.banned };
  },

  async "PUT /api/save"(req) {
    const p = auth(req);
    if (!p) return [401, { error: "Not signed in." }];
    if (p.banned) return [403, { error: "This account is banned." }];
    if (limited("save", p.id)) return [429, { error: "Saving too often." }];
    const b = await readBody(req, MAX_SAVE);
    const ch = CHANNELS.has(b.channel) ? b.channel : null;
    if (!ch || typeof b.save !== "string") return [400, { error: "Missing save." }];
    let save;
    try { save = JSON.parse(b.save); } catch { return [400, { error: "That save isn't readable." }]; }
    if (!save || typeof save !== "object" || Array.isArray(save)) return [400, { error: "That save isn't readable." }];
    const st = stats(save), t = now();
    const prev = q("SELECT * FROM scores WHERE player_id=? AND channel=?").get(p.id, ch);
    checkSave(p.id, ch, save, st, prev);
    q("INSERT INTO saves(player_id,channel,data,updated) VALUES(?,?,?,?) ON CONFLICT(player_id,channel) DO UPDATE SET data=excluded.data, updated=excluded.updated").run(p.id, ch, b.save, t);
    q(`INSERT INTO scores(player_id,channel,ever,best,clicks,play,asc,crown,ach,cheat,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(player_id,channel) DO UPDATE SET ever=excluded.ever,best=excluded.best,clicks=excluded.clicks,play=excluded.play,
       asc=excluded.asc,crown=excluded.crown,ach=excluded.ach,cheat=excluded.cheat,updated=excluded.updated`)
      .run(p.id, ch, st.ever, st.best, st.clicks, st.play, st.asc, st.crown, st.ach, st.cheat, t);
    return { ok: true, savedAt: t, cheat: !!st.cheat };
  },

  "GET /api/save"(req, url) {
    const p = auth(req);
    if (!p) return [401, { error: "Not signed in." }];
    if (limited("load", p.id)) return [429, { error: "Loading too often." }];
    const ch = url.searchParams.get("channel");
    if (!CHANNELS.has(ch)) return [400, { error: "Bad channel." }];
    const r = q("SELECT data, updated FROM saves WHERE player_id=? AND channel=?").get(p.id, ch);
    return { save: r ? r.data : null, savedAt: r ? r.updated : null, time: now() };
  },

  "GET /api/leaderboard"(req, url) {
    if (limited("board", clientIp(req))) return [429, { error: "Slow down." }];
    const ch = url.searchParams.get("channel"), board = url.searchParams.get("board") || "ever";
    if (!CHANNELS.has(ch) || !["ever", "best", "clicks", "play", "ach"].includes(board)) return [400, { error: "Bad board." }];
    const limit = Math.min(100, Math.max(1, +url.searchParams.get("limit") || 50));
    const rows = q(`SELECT p.name, p.tag, s.${board} AS v, s.updated FROM scores s JOIN players p ON p.id=s.player_id
      WHERE s.channel=? AND s.cheat=0 AND p.banned=0 AND p.hidden=0 ORDER BY s.${board} DESC, s.updated ASC LIMIT ?`).all(ch, limit);
    let me = null;
    const p = auth(req);
    if (p) {
      const m = q(`SELECT ${board} AS v, cheat FROM scores WHERE player_id=? AND channel=?`).get(p.id, ch);
      if (m) {
        const off = m.cheat || p.banned || p.hidden;
        const rank = off ? null : q(`SELECT COUNT(*) AS n FROM scores s JOIN players p ON p.id=s.player_id WHERE s.channel=? AND s.cheat=0 AND p.banned=0 AND p.hidden=0 AND s.${board}>?`).get(ch, m.v).n + 1;
        me = { name: p.name, tag: p.tag || null, v: m.v, rank, off: off ? (m.cheat ? "cheat" : "hidden") : null };
      }
    }
    return { board, rows: rows.map((r, i) => ({ rank: i + 1, name: r.name, tag: r.tag || null, v: r.v })), me };
  },

  async "POST /api/event"(req) {
    if (limited("event", clientIp(req))) return [204, null];
    const b = await readBody(req, 4096);
    const ch = CHANNELS.has(b.channel) ? b.channel : null;
    const type = String(b.type || "");
    if (!ch || !isId(b.vid) || !isId(b.sid) || !["view", "beat", "open"].includes(type)) return [204, null];
    const name = b.name == null ? null : String(b.name).replace(/[^A-Za-z0-9 _.:-]/g, "").slice(0, 40);
    const t = now();
    if (type === "beat") {
      // a heartbeat while the tab is open; we keep one row per visit and update how long it lasted
      const secs = Math.min(86400, Math.max(0, Math.floor(num(b.secs))));
      const r = q("UPDATE events SET secs=MAX(COALESCE(secs,0),?), at=? WHERE sid=? AND type='view'").run(secs, t, b.sid);
      if (r.changes) return [204, null];
    }
    q("INSERT INTO events(at,day,channel,vid,sid,type,name,secs) VALUES(?,?,?,?,?,?,?,?)").run(t, day(t), ch, b.vid, b.sid, type === "beat" ? "view" : type, name, type === "beat" ? Math.floor(num(b.secs)) : null);
    return [204, null];
  },
};

// ---------- admin ----------
function adminOk(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = String(req.headers.authorization || "").match(/^Basic (.+)$/);
  if (!m) return false;
  const pass = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
  const a = Buffer.from(sha(pass)), b = Buffer.from(sha(ADMIN_PASSWORD));
  return crypto.timingSafeEqual(a, b);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const big = n => { n = +n || 0; if (n < 1e6) return Math.floor(n).toLocaleString("en-US"); const s = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"]; const e = Math.floor(Math.log10(n) / 3); return e < s.length ? (n / 10 ** (e * 3)).toFixed(2) + " " + s[e] : n.toExponential(2); };
const dur = s => { s = Math.round(s || 0); return s >= 3600 ? Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m" : s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; };

function adminPage(url) {
  const ch = CHANNELS.has(url.searchParams.get("channel")) ? url.searchParams.get("channel") : "beta";
  const t = now(), days = [];
  for (let i = 13; i >= 0; i--) days.push(day(t - i * 86400e3));
  const per = new Map(q(`SELECT day, COUNT(DISTINCT vid) AS people, COUNT(*) AS visits, AVG(secs) AS avg FROM events WHERE channel=? AND type='view' AND day>=? GROUP BY day`).all(ch, days[0]).map(r => [r.day, r]));
  const opens = q(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT vid) AS people FROM events WHERE channel=? AND type='open' AND day>=? GROUP BY name ORDER BY n DESC LIMIT 25`).all(ch, days[7]);
  const tot = q(`SELECT COUNT(DISTINCT vid) AS people, COUNT(*) AS visits, AVG(secs) AS avg FROM events WHERE channel=? AND type='view' AND day>=?`).get(ch, days[7]);
  const players = q("SELECT COUNT(*) AS n FROM scores WHERE channel=?").get(ch).n;
  const active = q("SELECT COUNT(*) AS n FROM scores WHERE channel=? AND updated>?").get(ch, t - 86400e3).n;
  const flags = q(`SELECT f.*, p.name, p.tag, p.hidden, p.banned FROM flags f JOIN players p ON p.id=f.player_id WHERE f.channel=? AND f.reviewed=0 ORDER BY f.at DESC LIMIT 100`).all(ch);
  const top = q(`SELECT p.id, p.name, p.tag, p.hidden, p.banned, s.* FROM scores s JOIN players p ON p.id=s.player_id WHERE s.channel=? ORDER BY s.ever DESC LIMIT 100`).all(ch);
  const maxP = Math.max(1, ...days.map(d => per.get(d)?.people || 0));
  const bars = days.map(d => { const r = per.get(d) || { people: 0, visits: 0, avg: 0 }; return `<div class="bar" title="${d}: ${r.people} people, ${r.visits} visits, avg ${dur(r.avg)}"><i style="height:${Math.round(r.people / maxP * 100)}%"></i><b>${r.people}</b><span>${d.slice(5)}</span></div>`; }).join("");
  const btn = (act, id, label) => `<form method="post" action="/admin/${act}?channel=${ch}"><input type="hidden" name="id" value="${id}"><button>${label}</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dueck Admin</title><style>
:root{--bg:#faf6ee;--card:#fff;--ink:#2a2420;--mute:#7a6f66;--line:#e6dccd;--acc:#c9252b;--ok:#1d7a4b}
@media(prefers-color-scheme:dark){:root{--bg:#1b1715;--card:#26201d;--ink:#f2ebe3;--mute:#a69a8f;--line:#3a322d}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
h1{margin:0 0 4px}h2{margin:28px 0 10px;font-size:18px}.sub{color:var(--mute)}a{color:var(--acc)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.tile b{display:block;font-size:24px}.tile span{color:var(--mute);font-size:13px}
.chart{display:flex;gap:4px;align-items:flex-end;height:160px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 10px 26px}
.bar{flex:1;height:100%;position:relative;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}.bar i{width:100%;background:var(--acc);border-radius:4px 4px 0 0;min-height:2px}.bar b{font-size:11px;position:absolute;top:-2px}.bar span{position:absolute;bottom:-20px;font-size:10px;color:var(--mute)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--mute);font-weight:600}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}form{display:inline}button{font:inherit;font-size:13px;padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
.tag{font-size:12px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--mute)}.tag.bad{color:var(--acc);border-color:var(--acc)}.wrapok{white-space:normal;min-width:260px}
</style></head><body><main>
<h1>Dueck Clicker admin</h1><div class="sub">Showing <b>${ch}</b> · switch to <a href="?channel=${ch === "beta" ? "main" : "beta"}">${ch === "beta" ? "main" : "beta"}</a></div>
<h2>Last 7 days</h2><div class="tiles">
<div class="tile"><b>${tot.people}</b><span>people</span></div><div class="tile"><b>${tot.visits}</b><span>visits</span></div>
<div class="tile"><b>${dur(tot.avg)}</b><span>average visit</span></div><div class="tile"><b>${players}</b><span>players on the leaderboard</span></div><div class="tile"><b>${active}</b><span>played in the last 24h</span></div></div>
<h2>People per day</h2><div class="chart">${bars}</div>
<h2>What people open (7 days)</h2><div class="wrap"><table><tr><th>Thing opened</th><th class="num">Times</th><th class="num">People</th></tr>
${opens.map(o => `<tr><td>${esc(o.name || "?")}</td><td class="num">${o.n}</td><td class="num">${o.people}</td></tr>`).join("") || `<tr><td colspan="3" class="sub">Nothing yet.</td></tr>`}</table></div>
<h2>Anti-cheat notes to review (${flags.length})</h2><div class="sub" style="margin-bottom:8px">Nothing happens to these players unless you press a button.</div>
<div class="wrap"><table><tr><th>Player</th><th>Why</th><th>When</th><th></th></tr>
${flags.map(f => `<tr><td>${esc(f.name)}${f.hidden ? ' <span class="tag">hidden</span>' : ""}${f.banned ? ' <span class="tag bad">banned</span>' : ""}</td><td class="wrapok"><b>${esc(f.reason)}</b><br><span class="sub">${esc(f.detail)}</span></td><td>${new Date(f.at).toLocaleString()}</td><td>${btn("dismiss", f.id, "Looks fine")} ${f.tag ? btn("untag", f.player_id, "Remove tag") + " " : ""}${f.hidden ? "" : btn("hide", f.player_id, "Hide from board")}</td></tr>`).join("") || `<tr><td colspan="4" class="sub">Nothing to review.</td></tr>`}</table></div>
<h2>Players (top 100 by Duecks made)</h2><div class="wrap"><table><tr><th>Name</th><th class="num">Duecks made</th><th class="num">Best /sec</th><th class="num">Clicks</th><th class="num">Played</th><th>Last save</th><th></th></tr>
${top.map(r => `<tr><td>${esc(r.name)}${r.tag ? ' <span class="tag bad">' + esc(r.tag) + "</span>" : ""}${r.cheat ? ' <span class="tag">beta tools</span>' : ""}${r.hidden ? ' <span class="tag">hidden</span>' : ""}${r.banned ? ' <span class="tag bad">banned</span>' : ""}</td><td class="num">${big(r.ever)}</td><td class="num">${big(r.best)}</td><td class="num">${big(r.clicks)}</td><td class="num">${dur(r.play)}</td><td>${new Date(r.updated).toLocaleString()}</td>
<td>${btn("rename", r.id, "Rename")} ${r.tag ? btn("untag", r.id, "Remove tag") + " " : ""}${r.hidden ? btn("unhide", r.id, "Show") : btn("hide", r.id, "Hide")} ${r.banned ? btn("unban", r.id, "Unban") : btn("ban", r.id, "Ban")}</td></tr>`).join("") || `<tr><td colspan="7" class="sub">No players yet.</td></tr>`}</table></div>
</main></body></html>`;
}
async function adminAction(req, res, url, act) {
  const body = await new Promise(ok => { let s = ""; req.on("data", c => { if (s.length < 1000) s += c; }); req.on("end", () => ok(s)); });
  const id = +new URLSearchParams(body).get("id");
  if (id > 0) {
    if (act === "dismiss") q("UPDATE flags SET reviewed=1 WHERE id=?").run(id);
    if (act === "rename") { let n = "Player" + id; while (q("SELECT 1 FROM players WHERE name=? AND id<>?").get(n, id)) n = "Player" + id + "_" + crypto.randomInt(1000); q("UPDATE players SET name=? WHERE id=?").run(n, id); }
    if (act === "untag") { q("UPDATE players SET tag=NULL WHERE id=?").run(id); q("UPDATE flags SET reviewed=1 WHERE player_id=? AND reason='AutoClicker tag'").run(id); }
    if (act === "hide" || act === "unhide") q("UPDATE players SET hidden=? WHERE id=?").run(act === "hide" ? 1 : 0, id);
    if (act === "ban" || act === "unban") q("UPDATE players SET banned=? WHERE id=?").run(act === "ban" ? 1 : 0, id);
    if (act === "hide" || act === "ban") q("UPDATE flags SET reviewed=1 WHERE player_id=?").run(id);
  }
  res.writeHead(303, { Location: "/admin?channel=" + (CHANNELS.has(url.searchParams.get("channel")) ? url.searchParams.get("channel") : "beta") });
  res.end();
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = req.headers.origin;
  const cors = origin && ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  try {
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!adminOk(req)) {
        if (limited("adminFail", clientIp(req))) return send(res, 429, "Too many wrong passwords. Wait 15 minutes.");
        return send(res, 401, ADMIN_PASSWORD ? "Password needed." : "Set ADMIN_PASSWORD in the .env file to turn this page on.", { "WWW-Authenticate": 'Basic realm="Dueck admin"' });
      }
      if (req.method === "POST" && url.pathname.startsWith("/admin/")) return adminAction(req, res, url, url.pathname.slice(7));
      return send(res, 200, adminPage(url));
    }
    if (req.method === "OPTIONS") {
      return send(res, 204, "", { ...cors, "Access-Control-Allow-Methods": "GET,POST,PUT", "Access-Control-Allow-Headers": "Content-Type,Authorization", "Access-Control-Max-Age": "86400" });
    }
    const h = routes[req.method + " " + url.pathname];
    if (!h) return send(res, 404, { error: "Not found." }, cors);
    let out = await h(req, url);
    let code = 200;
    if (Array.isArray(out)) [code, out] = out;
    if (code === 204) { res.writeHead(204, cors); return res.end(); }
    send(res, code, out, cors);
  } catch (e) {
    if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.code === 413 ? "Too big." : "Bad request." }, cors);
    console.error(e);
    send(res, 500, { error: "Server error." }, cors);
  }
});

// ---------- upkeep: nightly backup, and drop analytics older than 400 days ----------
function upkeep() {
  try {
    const f = path.join(BACKUP_DIR, `dueck-${day(now())}.db`);
    if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(BACKUP_DIR).filter(n => /^dueck-\d{4}-\d\d-\d\d\.db$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, n));
    q("DELETE FROM events WHERE at<?").run(now() - 400 * 86400e3);
  } catch (e) { console.error("upkeep failed:", e.message); }
}
setTimeout(upkeep, 10e3).unref();
setInterval(upkeep, 6 * 3600e3).unref();

server.listen(PORT, HOST, () => console.log(`Dueck server listening on http://${HOST}:${PORT}  (allowed sites: ${ORIGINS.join(", ")})`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
