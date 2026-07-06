
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const allowlist = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowlist.length === 0 || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false
}));

const PORT = Number(process.env.PORT || 8080);
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const BUY_IN = Number(process.env.BUY_IN || 20);
const ADMIN_FEE_PERCENT = Math.max(5, Number(process.env.ADMIN_FEE_PERCENT || 5));
const DEFAULT_PAYOUT_SPLIT = process.env.PAYOUT_SPLIT || '70/20/10';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

if (!ODDS_API_KEY) {
  console.error('Missing ODDS_API_KEY in .env');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const SLATE_DIR = path.join(DATA_DIR, 'slates');
const ENTRIES_PATH = path.join(DATA_DIR, 'entries.jsonl');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');
const CSV_PATH = path.join(DATA_DIR, 'entries.csv');
for (const dir of [DATA_DIR, SLATE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Sport profiles. Add more keys as you launch more pools.
const SPORT_PROFILES = {
  soccer_fifa_world_cup: {
    label: 'World Cup',
    title: 'World Cup Weekly Pool',
    sport: 'soccer',
    scoreType: 'soccer'
  },
  americanfootball_nfl: {
    label: 'NFL',
    title: 'NFL Weekly Pool',
    sport: 'americanfootball',
    scoreType: 'binary'
  },
  americanfootball_ncaaf: {
    label: 'College Football',
    title: 'College Football Weekly Pool',
    sport: 'americanfootball',
    scoreType: 'binary'
  },
  basketball_nba: {
    label: 'NBA',
    title: 'NBA Weekly Pool',
    sport: 'basketball',
    scoreType: 'binary'
  },
  icehockey_nhl: {
    label: 'NHL',
    title: 'NHL Weekly Pool',
    sport: 'icehockey',
    scoreType: 'binary'
  },
  baseball_mlb: {
    label: 'MLB',
    title: 'MLB Weekly Pool',
    sport: 'baseball',
    scoreType: 'binary'
  },
  soccer_usa_mls: {
    label: 'MLS',
    title: 'MLS Weekly Pool',
    sport: 'soccer',
    scoreType: 'soccer'
  },
  golf_pga: {
    label: 'Golf',
    title: 'Golf Pool',
    sport: 'golf',
    scoreType: 'winner'
  }
};

function authAdmin(req, res, next) {
  if (ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  return txt.split('\n').map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function ensureCsvHeader() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      ['timestamp','pool_id','sport_key','name','email','tiebreaker_total',
       'pick1','pick2','pick3','pick4','pick5','pick6','pick7','pick8','pick9'].join(',') + '\n',
      'utf8'
    );
  }
}

function csvSanitize(v) {
  return String(v ?? '').replace(/\r?\n/g, ' ').replace(/,/g, ';');
}

async function oddsFetch(endpoint, params = {}) {
  const url = new URL(`${ODDS_BASE}${endpoint}`);
  url.searchParams.set('apiKey', ODDS_API_KEY);
  Object.entries(params).forEach(([key, val]) => {
    if (Array.isArray(val)) {
      url.searchParams.set(key, val.join(','));
    } else if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val));
    }
  });
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`The Odds API ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function getRestOfWeekRange() {
  const now = new Date();
  const end = new Date(now);
  const day = end.getDay();
  const daysUntilSunday = (7 - day) % 7;
  end.setDate(end.getDate() + daysUntilSunday);
  end.setHours(23,59,59,999);
  return { start: now, end };
}

function getWeekId(start) {
  const d = new Date(start);
  const y = d.getFullYear();
  const first = new Date(y, 0, 1);
  const week = Math.ceil((((d - first) / 86400000) + first.getDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2,'0')}`;
}

function slatePath(poolId) {
  return path.join(SLATE_DIR, `${poolId}.json`);
}

function readSlate(poolId) {
  const p = slatePath(poolId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSlate(slate) {
  fs.writeFileSync(slatePath(slate.pool_id), JSON.stringify(slate, null, 2), 'utf8');
}

function formatEventLabel(e) {
  // The Odds API uses home_team and away_team when applicable; golf outrights can be different.
  if (e.away_team && e.home_team) return `${e.away_team} vs ${e.home_team}`;
  if (e.commence_time) return `${e.sport_title || 'Event'} — ${new Date(e.commence_time).toLocaleString()}`;
  return e.id || 'Event';
}

function chooseBestBookmaker(event) {
  // Prefer DraftKings/FanDuel/BetMGM/Caesars if present, otherwise first bookmaker.
  const preferred = ['draftkings','fanduel','betmgm','caesars','espnbet','pointsbetus','bet365'];
  const books = event.bookmakers || [];
  for (const key of preferred) {
    const found = books.find(b => b.key === key);
    if (found) return found;
  }
  return books[0] || null;
}

function findMarket(bookmaker, key) {
  return (bookmaker?.markets || []).find(m => m.key === key);
}

function americanProb(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return p < 0 ? (-p / (-p + 100)) : (100 / (p + 100));
}

function getH2HPick(event) {
  const book = chooseBestBookmaker(event);
  const m = findMarket(book, 'h2h');
  if (!m || !Array.isArray(m.outcomes) || m.outcomes.length < 2) return null;

  // For soccer, h2h may include Draw. We keep every outcome.
  const outcomes = m.outcomes.map(o => ({
    key: String(o.name),
    label: String(o.name),
    odds: Number(o.price)
  })).filter(o => Number.isFinite(o.odds));

  if (outcomes.length < 2) return null;

  const probs = outcomes.map(o => americanProb(o.odds)).filter(x => x !== null);
  const closeness = probs.length ? Math.max(...probs) - Math.min(...probs) : 999;

  return {
    market: 'ML',
    event_id: event.id,
    event_label: formatEventLabel(event),
    datetime: event.commence_time,
    home_team: event.home_team || null,
    away_team: event.away_team || null,
    bookmaker: book.title || book.key,
    options: outcomes,
    closeness
  };
}

function getSpreadPick(event) {
  const book = chooseBestBookmaker(event);
  const m = findMarket(book, 'spreads');
  if (!m || !Array.isArray(m.outcomes) || m.outcomes.length < 2) return null;

  const outcomes = m.outcomes.map(o => ({
    key: String(o.name),
    label: `${o.name} ${Number(o.point) > 0 ? '+' : ''}${o.point}`,
    line: Number(o.point),
    odds: Number(o.price)
  })).filter(o => Number.isFinite(o.line) && Number.isFinite(o.odds));

  if (outcomes.length < 2) return null;
  const closeness = Math.min(...outcomes.map(o => Math.abs(o.line)));

  return {
    market: 'SP',
    event_id: event.id,
    event_label: formatEventLabel(event),
    datetime: event.commence_time,
    home_team: event.home_team || null,
    away_team: event.away_team || null,
    bookmaker: book.title || book.key,
    options: outcomes,
    closeness
  };
}

function getTotalPick(event) {
  const book = chooseBestBookmaker(event);
  const m = findMarket(book, 'totals');
  if (!m || !Array.isArray(m.outcomes) || m.outcomes.length < 2) return null;

  const outcomes = m.outcomes.map(o => ({
    key: String(o.name).toLowerCase(),
    label: `${o.name} ${o.point}`,
    line: Number(o.point),
    odds: Number(o.price)
  })).filter(o => ['over','under'].includes(o.key) && Number.isFinite(o.line) && Number.isFinite(o.odds));

  if (outcomes.length < 2) return null;
  const line = outcomes[0].line;
  return {
    market: 'TOT',
    event_id: event.id,
    event_label: formatEventLabel(event),
    datetime: event.commence_time,
    home_team: event.home_team || null,
    away_team: event.away_team || null,
    bookmaker: book.title || book.key,
    line,
    options: outcomes,
    closeness: Math.abs(line)
  };
}

function filterEventsThisWeek(events, range) {
  const inRange = events
    .filter(e => e.commence_time)
    .filter(e => new Date(e.commence_time) >= range.start && new Date(e.commence_time) <= range.end)
    .sort((a,b)=>new Date(a.commence_time)-new Date(b.commence_time));

  // If not enough events for this week, widen to next 14 days.
  if (inRange.length >= 9) return inRange;
  const wideEnd = new Date(range.start);
  wideEnd.setDate(wideEnd.getDate() + 14);
  return events
    .filter(e => e.commence_time)
    .filter(e => new Date(e.commence_time) >= range.start && new Date(e.commence_time) <= wideEnd)
    .sort((a,b)=>new Date(a.commence_time)-new Date(b.commence_time));
}

function buildFallbackPicks(events) {
  const chosen = events.slice(0,9);
  const ml = chosen.slice(0,3).map(e => ({
    market:'ML', event_id:e.id, event_label:formatEventLabel(e), datetime:e.commence_time,
    home_team:e.home_team||null, away_team:e.away_team||null, bookmaker:'fallback',
    options:[
      e.away_team ? {key:e.away_team,label:e.away_team,odds:null} : null,
      e.home_team && e.away_team ? {key:'Draw',label:'Draw',odds:null} : null,
      e.home_team ? {key:e.home_team,label:e.home_team,odds:null} : null
    ].filter(Boolean),
    fallback:true
  }));
  const sp = chosen.slice(3,6).map(e => ({
    market:'SP', event_id:e.id, event_label:formatEventLabel(e), datetime:e.commence_time,
    home_team:e.home_team||null, away_team:e.away_team||null, bookmaker:'fallback',
    options:[
      e.away_team ? {key:e.away_team,label:`${e.away_team} +0.5`,line:0.5,odds:null} : null,
      e.home_team ? {key:e.home_team,label:`${e.home_team} -0.5`,line:-0.5,odds:null} : null
    ].filter(Boolean),
    fallback:true
  }));
  const tot = chosen.slice(6,9).map(e => ({
    market:'TOT', event_id:e.id, event_label:formatEventLabel(e), datetime:e.commence_time,
    home_team:e.home_team||null, away_team:e.away_team||null, bookmaker:'fallback',
    line:2.5,
    options:[{key:'over',label:'Over 2.5',line:2.5,odds:null},{key:'under',label:'Under 2.5',line:2.5,odds:null}],
    fallback:true
  }));
  return [...ml, ...sp, ...tot];
}

async function buildSlate({ sportKey = process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup', forceStart, forceEnd } = {}) {
  const profile = SPORT_PROFILES[sportKey] || { label: sportKey, title: `${sportKey} Weekly Pool`, sport:'unknown', scoreType:'binary' };
  const range = forceStart && forceEnd ? { start:new Date(forceStart), end:new Date(forceEnd) } : getRestOfWeekRange();
  const weekId = getWeekId(range.start);
  const poolId = `${sportKey}-${weekId}`;

  const events = await oddsFetch(`/sports/${sportKey}/odds`, {
    regions: process.env.ODDS_REGIONS || 'us',
    markets: 'h2h,spreads,totals',
    oddsFormat: 'american',
    dateFormat: 'iso'
  });

  const relevant = filterEventsThisWeek(events, range);
  if (!relevant.length) throw new Error(`No upcoming events found for ${sportKey}. Try a different sport key or date window.`);

  const ml = relevant.map(getH2HPick).filter(Boolean).sort((a,b)=>a.closeness-b.closeness).slice(0,3);
  const sp = relevant.map(getSpreadPick).filter(Boolean).sort((a,b)=>a.closeness-b.closeness).slice(0,3);
  // For totals, choose totals closest to median line rather than blindly lowest.
  let totals = relevant.map(getTotalPick).filter(Boolean);
  if (totals.length) {
    const lines = totals.map(t => Number(t.line)).filter(Number.isFinite).sort((a,b)=>a-b);
    const median = lines[Math.floor(lines.length/2)];
    totals = totals.sort((a,b)=>Math.abs(a.line-median)-Math.abs(b.line-median)).slice(0,3);
  }

  let picks = [...ml, ...sp, ...totals];

  if (picks.length < 9) {
    const fallback = buildFallbackPicks(relevant);
    const seen = new Set(picks.map(p => `${p.market}:${p.event_id}`));
    for (const p of fallback) {
      if (picks.length >= 9) break;
      const k = `${p.market}:${p.event_id}`;
      if (!seen.has(k) && p.options && p.options.length >= 2) {
        picks.push(p);
        seen.add(k);
      }
    }
  }

  if (picks.length < 9) {
    throw new Error(`Only found ${picks.length}/9 playable markets for ${sportKey}.`);
  }

  picks = picks.slice(0,9).map((p, idx) => ({ ...p, pick_id: `${p.market}-${p.event_id}-${idx}` }));

  const slate = {
    pool_id: poolId,
    sport_key: sportKey,
    sport_label: profile.label,
    score_type: profile.scoreType,
    title: `${profile.title} — ${range.start.toLocaleDateString()} to ${range.end.toLocaleDateString()}`,
    created_at: new Date().toISOString(),
    start_at: range.start.toISOString(),
    end_at: range.end.toISOString(),
    buy_in: BUY_IN,
    admin_fee_percent: ADMIN_FEE_PERCENT,
    payout_split: DEFAULT_PAYOUT_SPLIT,
    locked_at: null,
    share_url: `${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(sportKey)}`,
    picks,
    meta: { provider: 'the-odds-api', fallback_count: picks.filter(p=>p.fallback).length }
  };

  saveSlate(slate);
  return slate;
}

async function getCurrentSlate(sportKey = process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup') {
  const range = getRestOfWeekRange();
  const poolId = `${sportKey}-${getWeekId(range.start)}`;
  let slate = readSlate(poolId);
  if (!slate) slate = await buildSlate({ sportKey });
  return slate;
}

function parseSplit(split) {
  const parts = String(split || '70/20/10').split('/').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n)) || Math.round(parts.reduce((a,b)=>a+b,0)) !== 100) return [70,20,10];
  return parts;
}

function computePayouts(entryCount, slate) {
  const gross = entryCount * Number(slate.buy_in || BUY_IN);
  const feePct = Math.max(5, Number(slate.admin_fee_percent || ADMIN_FEE_PERCENT));
  const fee = gross * feePct / 100;
  const net = gross - fee;
  const [w,s,t] = parseSplit(slate.payout_split || DEFAULT_PAYOUT_SPLIT);
  return { entrants:entryCount, buy_in:Number(slate.buy_in || BUY_IN), gross, admin_fee_percent:feePct, admin_fee:fee, net_pot:net, first:net*w/100, second:net*s/100, third:net*t/100 };
}

function loadTokens() {
  try { return fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) : {}; } catch { return {}; }
}
function saveTokens(tokens) { fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8'); }
function createReplaceToken(snapshot) {
  const tokens = loadTokens();
  const token = crypto.randomUUID();
  const now = Date.now();
  const ttlHours = Math.max(1, Number(process.env.TOKEN_TTL_HOURS || 48));
  tokens[token] = { email: normalizeEmail(snapshot.email), pool_id: snapshot.pool_id, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlHours*3600000).toISOString(), snapshot };
  saveTokens(tokens);
  return token;
}
function validateReplaceToken(token) {
  const tokens = loadTokens();
  const rec = tokens[token];
  if (!rec) return null;
  if (Date.now() > Date.parse(rec.expires_at)) return null;
  const slate = readSlate(rec.pool_id);
  if (slate && slate.locked_at) return null;
  const ttlHours = Math.max(1, Number(process.env.TOKEN_TTL_HOURS || 48));
  rec.expires_at = new Date(Date.now() + ttlHours*3600000).toISOString();
  saveTokens(tokens);
  return rec;
}

let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  mailer = nodemailer.createTransport({ host:SMTP_HOST, port:Number(SMTP_PORT), secure:Number(SMTP_PORT)===465, auth:{user:SMTP_USER, pass:SMTP_PASS} });
  return mailer;
}
async function sendReceipt(entry, replaceToken) {
  const tx = getMailer();
  if (!tx) return false;
  const replaceLink = `${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(entry.sport_key)}&replaceToken=${encodeURIComponent(replaceToken)}`;
  const lines = entry.picks.map((p,i)=>`${i+1}. [${p.market}] ${p.event_label} — ${p.label}`).join('\n');
  await tx.sendMail({
    from: process.env.SMTP_FROM || 'Pool Picks <no-reply@example.com>',
    to: entry.email,
    bcc: process.env.ORGANIZER_EMAIL || undefined,
    subject: `Confirmation: ${entry.pool_title}`,
    text: `Thanks ${entry.name}, your picks are in.\n\n${lines}\n\nTiebreaker: ${entry.tiebreaker_total ?? '(none)'}\n\nReplace your picks until the pool locks:\n${replaceLink}\n`
  });
  return true;
}

// ---------- Routes ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));


function buildManualFallbackSlate({ sportKey = process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup' } = {}) {
  const profile = SPORT_PROFILES[sportKey] || { label: sportKey, title: `${sportKey} Pool`, scoreType:'binary' };
  const range = getRestOfWeekRange();
  const weekId = getWeekId(range.start);
  const poolId = `${sportKey}-${weekId}`;

  const starts = Array.from({ length: 9 }, (_, i) => {
    const d = new Date(range.start);
    d.setDate(d.getDate() + Math.floor(i / 3));
    d.setHours(19 + (i % 3), 0, 0, 0);
    return d.toISOString();
  });

  const pairs = [
    ['Team A','Team B'], ['Team C','Team D'], ['Team E','Team F'],
    ['Team G','Team H'], ['Team I','Team J'], ['Team K','Team L'],
    ['Team M','Team N'], ['Team O','Team P'], ['Team Q','Team R']
  ];

  const events = pairs.map((pair, i) => ({
    id: `manual-${sportKey}-${weekId}-${i+1}`,
    away_team: pair[0],
    home_team: pair[1],
    event_label: `${pair[0]} vs ${pair[1]}`,
    datetime: starts[i]
  }));

  const isSoccer = String(sportKey).startsWith('soccer');
  const totalLine = isSoccer ? 2.5 : 45.5;

  const picks = [
    ...events.slice(0,3).map((e, idx) => ({
      pick_id:`ML-${e.id}-${idx}`,
      market:'ML',
      event_id:e.id,
      event_label:e.event_label,
      datetime:e.datetime,
      home_team:e.home_team,
      away_team:e.away_team,
      bookmaker:'manual',
      options:[
        { key:e.away_team, label:e.away_team, odds:null },
        ...(isSoccer ? [{ key:'Draw', label:'Draw', odds:null }] : []),
        { key:e.home_team, label:e.home_team, odds:null }
      ],
      fallback:true,
      manual:true
    })),
    ...events.slice(3,6).map((e, idx) => ({
      pick_id:`SP-${e.id}-${idx+3}`,
      market:'SP',
      event_id:e.id,
      event_label:e.event_label,
      datetime:e.datetime,
      home_team:e.home_team,
      away_team:e.away_team,
      bookmaker:'manual',
      options:[
        { key:e.away_team, label:`${e.away_team} +1.5`, line:1.5, odds:null },
        { key:e.home_team, label:`${e.home_team} -1.5`, line:-1.5, odds:null }
      ],
      fallback:true,
      manual:true
    })),
    ...events.slice(6,9).map((e, idx) => ({
      pick_id:`TOT-${e.id}-${idx+6}`,
      market:'TOT',
      event_id:e.id,
      event_label:e.event_label,
      datetime:e.datetime,
      home_team:e.home_team,
      away_team:e.away_team,
      bookmaker:'manual',
      line:totalLine,
      options:[
        { key:'over', label:`Over ${totalLine}`, line:totalLine, odds:null },
        { key:'under', label:`Under ${totalLine}`, line:totalLine, odds:null }
      ],
      fallback:true,
      manual:true
    }))
  ];

  const slate = {
    pool_id: poolId,
    sport_key: sportKey,
    sport_label: profile.label,
    score_type: profile.scoreType || 'binary',
    title: `${profile.title || profile.label + ' Pool'} — Manual Fallback Slate`,
    created_at: new Date().toISOString(),
    start_at: range.start.toISOString(),
    end_at: range.end.toISOString(),
    buy_in: BUY_IN,
    admin_fee_percent: ADMIN_FEE_PERCENT,
    payout_split: DEFAULT_PAYOUT_SPLIT,
    locked_at: null,
    share_url: `${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(sportKey)}`,
    picks,
    meta: {
      provider:'manual-fallback',
      fallback_count:9,
      note:'Manual placeholder slate created because API regeneration was unavailable.'
    }
  };

  saveSlate(slate);
  return slate;
}

app.post('/api/slate/manual-fallback', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const existing = await getCurrentSlate(sportKey).catch(() => null);
    if (existing && existing.locked_at) {
      return res.status(409).json({ error:'Slate is locked. Unlock before creating a manual fallback slate.' });
    }
    const slate = buildManualFallbackSlate({ sportKey });
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to create manual fallback slate.' });
  }
});


app.get('/api/sports', async (_req, res) => {
  try {
    const all = await oddsFetch('/sports');
    res.json({ supported_profiles: SPORT_PROFILES, odds_api_sports: all });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to fetch sports.' });
  }
});

app.get('/api/test-api', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const sports = await oddsFetch('/sports');
    const odds = await oddsFetch(`/sports/${sportKey}/odds`, { regions:process.env.ODDS_REGIONS || 'us', markets:'h2h,spreads,totals', oddsFormat:'american', dateFormat:'iso' });
    res.json({ ok:true, sportKey, sports_count:sports.length, events_with_odds:odds.length, sample:odds.slice(0,2) });
  } catch (e) {
    res.status(e.status || 500).json({ ok:false, error:e.message });
  }
});

app.get('/api/slate/current', async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const slate = await getCurrentSlate(sportKey);
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to build slate' });
  }
});

app.post('/api/slate/regenerate', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const existing = await getCurrentSlate(sportKey).catch(()=>null);
    if (existing && existing.locked_at) return res.status(409).json({ error:'Slate is locked. Unlock before regenerating.' });
    const slate = await buildSlate({ sportKey, forceStart:req.query.start, forceEnd:req.query.end });
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to regenerate slate' });
  }
});

app.post('/api/slate/lock', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const slate = await getCurrentSlate(sportKey);
    if (!slate.locked_at) { slate.locked_at = new Date().toISOString(); saveSlate(slate); }
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to lock slate' });
  }
});

app.post('/api/slate/unlock', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const slate = await getCurrentSlate(sportKey);
    slate.locked_at = null;
    saveSlate(slate);
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to unlock slate' });
  }
});

app.get('/api/entries/check', async (req, res) => {
  const poolId = String(req.query.pool_id || '');
  const email = normalizeEmail(req.query.email);
  if (!poolId || !email) return res.status(400).json({ error:'Missing pool_id/email' });
  const exists = readJsonl(ENTRIES_PATH).some(e => e.pool_id === poolId && normalizeEmail(e.email) === email);
  res.json({ exists });
});

app.get('/api/entries/replace/prefill', (req, res) => {
  const token = String(req.query.token || '');
  const rec = validateReplaceToken(token);
  if (!rec) return res.status(404).json({ error:'Invalid, expired, or locked replace link' });
  res.json({ token, snapshot:rec.snapshot, expires_at:rec.expires_at });
});

app.post('/api/entries', async (req, res) => {
  try {
    const { name, email, pool_id, picks, tiebreaker_total } = req.body || {};
    if (!name || !email || !pool_id || !Array.isArray(picks) || picks.length !== 9) {
      return res.status(400).json({ error:'Expected name, email, pool_id, and exactly 9 picks.' });
    }
    const slate = readSlate(pool_id);
    if (!slate) return res.status(404).json({ error:'Pool/slate not found.' });
    if (slate.locked_at) return res.status(409).json({ error:'Pool is locked. Picks can no longer be changed.' });

    const replaceToken = String(req.query.replaceToken || '');
    const tokenRec = replaceToken ? validateReplaceToken(replaceToken) : null;
    const usingReplace = !!(tokenRec && tokenRec.email === normalizeEmail(email) && tokenRec.pool_id === pool_id);

    const existing = readJsonl(ENTRIES_PATH).some(e => e.pool_id === pool_id && normalizeEmail(e.email) === normalizeEmail(email));
    if (existing && !usingReplace) {
      return res.status(409).json({ error:'You have already submitted for this pool. Use the replace link from your receipt.' });
    }

    const normalizedPicks = picks.map(p => {
      const slatePick = slate.picks.find(x => x.pick_id === p.pick_id);
      const option = slatePick?.options?.find(o => o.key === p.pick);
      return {
        pick_id:p.pick_id,
        market:slatePick?.market || p.market,
        event_id:slatePick?.event_id || p.event_id,
        event_label:slatePick?.event_label || p.event_label,
        pick:p.pick,
        label:option?.label || p.label,
        line:option?.line ?? slatePick?.line ?? null,
        odds:option?.odds ?? null
      };
    });

    const entry = {
      timestamp:new Date().toISOString(),
      pool_id,
      sport_key:slate.sport_key,
      pool_title:slate.title,
      name,
      email,
      tiebreaker_total,
      picks:normalizedPicks
    };

    appendJsonl(ENTRIES_PATH, entry);
    ensureCsvHeader();
    fs.appendFileSync(CSV_PATH, [
      entry.timestamp, pool_id, slate.sport_key, csvSanitize(name), csvSanitize(email), csvSanitize(tiebreaker_total),
      ...normalizedPicks.map(p => csvSanitize(`[${p.market}] ${p.event_label} — ${p.label}`))
    ].join(',') + '\n', 'utf8');

    const newToken = createReplaceToken(entry);
    sendReceipt(entry, newToken).catch(e => console.error('Receipt failed:', e.message));

    res.json({ ok:true, replaced:usingReplace, receipt_sent_if_smtp_configured:true });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to save entry.' });
  }
});

app.get('/api/entries.csv', authAdmin, (_req, res) => {
  ensureCsvHeader();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pool-entries.csv"');
  fs.createReadStream(CSV_PATH).pipe(res);
});



app.get('/api/admin/slates', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || '');
    const files = fs.existsSync(SLATE_DIR) ? fs.readdirSync(SLATE_DIR).filter(f => f.endsWith('.json')) : [];
    const slates = files.map(f => {
      try {
        const slate = JSON.parse(fs.readFileSync(path.join(SLATE_DIR, f), 'utf8'));
        return {
          pool_id: slate.pool_id,
          sport_key: slate.sport_key,
          title: slate.title,
          created_at: slate.created_at,
          locked_at: slate.locked_at,
          picks_count: Array.isArray(slate.picks) ? slate.picks.length : 0,
          filename: f
        };
      } catch { return null; }
    }).filter(Boolean)
      .filter(s => !sportKey || s.sport_key === sportKey)
      .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ slates, total: slates.length });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load saved slates.' });
  }
});

app.get('/api/admin/slate/:poolId', authAdmin, async (req, res) => {
  try {
    const poolId = String(req.params.poolId || '');
    const slate = readSlate(poolId);
    if (!slate) return res.status(404).json({ error:'Saved slate not found.' });
    res.json(slate);
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load saved slate.' });
  }
});

app.get('/api/admin/all-entries', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || '');
    const entries = readJsonl(ENTRIES_PATH)
      .filter(e => !sportKey || e.sport_key === sportKey)
      .sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const byPool = {};
    for (const e of entries) {
      byPool[e.pool_id] = (byPool[e.pool_id] || 0) + 1;
    }
    res.json({ entries, byPool, total: entries.length });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load all entries.' });
  }
});


app.get('/api/admin/current-or-latest', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    try {
      const slate = await getCurrentSlate(sportKey);
      const entries = readJsonl(ENTRIES_PATH).filter(e => e.pool_id === slate.pool_id);
      return res.json({ source:'current', slate, entries, payouts:computePayouts(entries.length, slate), share_url:`${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(sportKey)}` });
    } catch (apiErr) {
      const files = fs.existsSync(SLATE_DIR) ? fs.readdirSync(SLATE_DIR).filter(f => f.endsWith('.json')) : [];
      const slates = files.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(SLATE_DIR, f), 'utf8')); } catch { return null; }
      }).filter(Boolean)
        .filter(s => s.sport_key === sportKey)
        .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (slates.length) {
        const slate = slates[0];
        const entries = readJsonl(ENTRIES_PATH).filter(e => e.pool_id === slate.pool_id);
        return res.json({ source:'latest_saved_after_api_error', api_error: apiErr.message, slate, entries, payouts:computePayouts(entries.length, slate), share_url:`${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(sportKey)}` });
      }
      throw apiErr;
    }
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load current or saved slate.' });
  }
});

app.get('/api/admin/summary', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const slate = await getCurrentSlate(sportKey);
    const entries = readJsonl(ENTRIES_PATH).filter(e => e.pool_id === slate.pool_id);
    res.json({ slate, entries, payouts:computePayouts(entries.length, slate), share_url:`${PUBLIC_BASE_URL}/pool.html?sport=${encodeURIComponent(sportKey)}` });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load summary.' });
  }
});

async function getScoresForSport(sportKey) {
  try {
    return await oddsFetch(`/sports/${sportKey}/scores`, { daysFrom:3, dateFormat:'iso' });
  } catch {
    return [];
  }
}

function gradePick(pick, scoreEvent) {
  if (!scoreEvent || !Array.isArray(scoreEvent.scores) || !scoreEvent.completed) return { settled:false, correct:false };
  const scores = scoreEvent.scores.map(s => ({ name:s.name, score:Number(s.score) }));
  if (scores.length < 2 || scores.some(s => !Number.isFinite(s.score))) return { settled:false, correct:false };

  const selected = scores.find(s => s.name === pick.pick || s.name === pick.label || String(pick.label || '').startsWith(s.name));
  const other = scores.find(s => s !== selected);
  const total = scores.reduce((sum,s)=>sum+s.score,0);

  if (pick.market === 'ML') {
    if (pick.pick === 'Draw') return { settled:true, correct:scores[0].score === scores[1].score };
    if (!selected) return { settled:false, correct:false };
    return { settled:true, correct:selected.score > other.score };
  }
  if (pick.market === 'SP') {
    if (!selected || !Number.isFinite(Number(pick.line))) return { settled:false, correct:false };
    const diff = selected.score + Number(pick.line) - other.score;
    return { settled:true, correct:diff > 0, push:diff === 0 };
  }
  if (pick.market === 'TOT') {
    const line = Number(pick.line);
    if (!Number.isFinite(line)) return { settled:false, correct:false };
    if (total === line) return { settled:true, correct:false, push:true };
    return { settled:true, correct: pick.pick === 'over' ? total > line : total < line };
  }
  return { settled:false, correct:false };
}

app.get('/api/leaderboard', authAdmin, async (req, res) => {
  try {
    const sportKey = String(req.query.sport || process.env.DEFAULT_SPORT_KEY || 'soccer_fifa_world_cup');
    const slate = await getCurrentSlate(sportKey);
    const scores = await getScoresForSport(sportKey);
    const scoreMap = new Map(scores.map(s => [s.id, s]));
    const entries = readJsonl(ENTRIES_PATH).filter(e => e.pool_id === slate.pool_id);
    const graded = entries.map(e => {
      let correct=0, settled=0;
      const details = e.picks.map(p => {
        const g = gradePick(p, scoreMap.get(p.event_id));
        if (g.settled) settled++;
        if (g.correct) correct++;
        return { ...p, outcome:g };
      });
      return { ...e, correct, settled, details };
    }).sort((a,b)=>b.correct-a.correct || a.timestamp.localeCompare(b.timestamp));
    res.json({ slate, entries:graded, payouts:computePayouts(entries.length, slate) });
  } catch (e) {
    res.status(e.status || 500).json({ error:e.message || 'Failed to load leaderboard.' });
  }
});

const publicDir = path.join(__dirname, 'public');
app.get('/', (_req, res) => res.redirect('/pool.html'));
app.get('/admin', (req, res) => {
  const token = String(req.query.token || '');
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send('Forbidden');
  return res.sendFile(path.join(publicDir, 'admin.html'));
});
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Odds API pool app running at http://localhost:${PORT}`);
});
