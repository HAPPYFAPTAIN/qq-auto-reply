// QQ 自动回复：NapCat OneBot v11 收消息 -> 本地模型代理 -> 以本人 QQ 发送
// 配置文件：auto-relay.config.json
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const CONFIG_PATH = path.join(ROOT, 'auto-relay.config.json');
const HISTORY_PATH = path.join(DATA_DIR, 'qq-history.json');
const LOG_PATH = path.join(LOG_DIR, 'qq-onebot-relay.log');

function now() { return new Date().toISOString(); }
function log(...args) {
  const line = `[${now()}] ` + args.map(String).join(' ');
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
}

const defaultConfig = {
  qq: {
    enabled: true,
    onebotHttp: process.env.QQ_ONEBOT_HTTP || 'http://127.0.0.1:6098',
    onebotWs: process.env.QQ_ONEBOT_WS || 'ws://127.0.0.1:6098',
    token: process.env.QQ_ONEBOT_TOKEN || '',
    selfId: Number(process.env.QQ_SELF_ID || 0),
    replyPrivate: true,
    replyGroups: true,
    groupMode: 'all', // all | mention | whitelist
    groupWhitelist: [],
    privateBlacklist: [],
    groupBlacklist: [],
    maxRepliesPerSessionPerMin: 3,
    groupMaxRepliesPerSessionPerMin: 2,
    historyLimit: 24,
    replyDelaySec: [6, 18],
    privateReplyDelaySec: [4, 12],
    groupReplyDelaySec: [12, 35],
    lineIntervalSec: [2, 6],
    maxLinesPerReply: 6,
    privateReplyProbability: 1,
    groupReplyProbability: 0.45,
    quietHours: ['23:30-08:00'],
    privateKeywords: [],
    groupKeywords: []
  },
  llm: {
    baseUrl: 'http://127.0.0.1:8899/v1',
    model: 'deepseek-v4-flash',
    temperature: 0.75,
    maxTokens: 260,
    timeoutSec: 90
  },
  personaPath: path.join(ROOT, 'persona.txt')
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      ...defaultConfig,
      ...cfg,
      qq: { ...defaultConfig.qq, ...(cfg.qq || {}) },
      llm: { ...defaultConfig.llm, ...(cfg.llm || {}) },
    };
  } catch (e) {
    log('config missing/invalid, using defaults:', e.message);
    return defaultConfig;
  }
}

let cfg = loadConfig();
let personaCache = { mtime: 0, text: '' };
function persona() {
  try {
    const st = fs.statSync(cfg.personaPath);
    if (st.mtimeMs !== personaCache.mtime) {
      personaCache = { mtime: st.mtimeMs, text: fs.readFileSync(cfg.personaPath, 'utf8') };
    }
    return personaCache.text;
  } catch {
    return '你在替本人回 QQ 消息。自然、简短、像本人，不要暴露自己是 AI。';
  }
}

let histories = new Map();
try {
  const obj = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  histories = new Map(Object.entries(obj));
} catch {}
function saveHistories() {
  const obj = Object.fromEntries(histories);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
function pushHistory(key, role, content) {
  const limit = Number(cfg.qq.historyLimit || 24);
  const arr = histories.get(key) || [];
  arr.push({ role, content: String(content).slice(0, 2000), ts: Date.now() });
  while (arr.length > limit * 2) arr.shift();
  histories.set(key, arr);
  if (histories.size > 300) {
    const first = histories.keys().next().value;
    histories.delete(first);
  }
  saveHistories();
}

const rate = new Map();
function allowRate(key) {
  const isGroup = key.startsWith('g:');
  const max = Number(isGroup
    ? (cfg.qq.groupMaxRepliesPerSessionPerMin ?? cfg.qq.maxRepliesPerSessionPerMin ?? 5)
    : (cfg.qq.maxRepliesPerSessionPerMin ?? 5));
  const nowMs = Date.now();
  const arr = (rate.get(key) || []).filter((t) => nowMs - t < 60_000);
  if (arr.length >= max) {
    rate.set(key, arr);
    return false;
  }
  arr.push(nowMs);
  rate.set(key, arr);
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randBetween(range) {
  const a = Number(range?.[0] ?? 1), b = Number(range?.[1] ?? a);
  return (a + Math.random() * Math.max(0, b - a)) * 1000;
}

function timeToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) % 1440;
}

function inQuietHours() {
  const ranges = Array.isArray(cfg.qq.quietHours) ? cfg.qq.quietHours : [];
  if (!ranges.length) return false;
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  for (const range of ranges) {
    const [a, b] = String(range).split('-');
    const start = timeToMinutes(a);
    const end = timeToMinutes(b);
    if (start == null || end == null) continue;
    if (start === end) return true;
    if (start < end) {
      if (cur >= start && cur < end) return true;
    } else if (cur >= start || cur < end) {
      return true;
    }
  }
  return false;
}

function passProbability(p) {
  const n = Number(p);
  if (Number.isNaN(n) || n >= 1) return true;
  if (n <= 0) return false;
  return Math.random() < n;
}

function keywordHit(text, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return true;
  const t = String(text || '').toLowerCase();
  return keywords.some((k) => t.includes(String(k).toLowerCase()));
}

function segText(ev) {
  if (typeof ev.raw_message === 'string' && ev.raw_message.trim()) return ev.raw_message.trim();
  if (Array.isArray(ev.message)) {
    return ev.message.map((seg) => {
      if (seg.type === 'text') return seg.data?.text || '';
      if (seg.type === 'at') return `[CQ:at,qq=${seg.data?.qq}]`;
      return `[${seg.type}]`;
    }).join('').trim();
  }
  return String(ev.message || '').trim();
}

async function onebot(action, payload) {
  const url = cfg.qq.onebotHttp.replace(/\/$/, '') + '/' + action;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.qq.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${action} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  return text;
}

async function callLLM(messages) {
  const url = cfg.llm.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.llm.timeoutSec || 90) * 1000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages,
        temperature: Number(cfg.llm.temperature || 0.75),
        max_tokens: Number(cfg.llm.maxTokens || 260),
        stream: false,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(async () => ({ error: { message: await resp.text() } }));
    if (!resp.ok) throw new Error(data?.error?.message || `LLM HTTP ${resp.status}`);
    const content = data?.choices?.[0]?.message?.content;
    return String(content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function shouldHandle(ev) {
  if (!cfg.qq.enabled) return false;
  if (ev.post_type !== 'message') return false;
  const selfId = Number(cfg.qq.selfId || 0);
  if (selfId && Number(ev.user_id) === selfId) return false;
  const isGroup = ev.message_type === 'group';
  if (isGroup && !cfg.qq.replyGroups) return false;
  if (!isGroup && !cfg.qq.replyPrivate) return false;
  const uid = Number(ev.user_id || 0);
  const gid = Number(ev.group_id || 0);
  if (!isGroup && cfg.qq.privateBlacklist.map(Number).includes(uid)) return false;
  if (isGroup && cfg.qq.groupBlacklist.map(Number).includes(gid)) return false;
  if (isGroup) {
    const mode = String(cfg.qq.groupMode || 'all');
    const raw = segText(ev);
    if (mode === 'mention' && selfId && !raw.includes(`[CQ:at,qq=${selfId}]`)) return false;
    if (mode === 'whitelist' && !cfg.qq.groupWhitelist.map(Number).includes(gid)) return false;
  }
  return true;
}

async function handleMessage(ev) {
  if (!shouldHandle(ev)) return;
  const isGroup = ev.message_type === 'group';
  const key = isGroup ? `g:${ev.group_id}` : `p:${ev.user_id}`;
  if (!allowRate(key)) {
    log('rate-limited', key);
    return;
  }
  const text = segText(ev);
  if (!text) return;
  const senderName = ev.sender?.card || ev.sender?.nickname || String(ev.user_id || '');
  const incoming = isGroup
    ? `[群聊 ${ev.group_id}｜${senderName}(${ev.user_id})] ${text}`
    : `[私聊｜${senderName}(${ev.user_id})] ${text}`;
  log('recv', key, incoming.slice(0, 200));

  if (inQuietHours()) {
    log('skip-quiet-hours', key);
    pushHistory(key, 'user', incoming);
    return;
  }
  if (!keywordHit(text, isGroup ? cfg.qq.groupKeywords : cfg.qq.privateKeywords)) {
    log('skip-keywords', key);
    pushHistory(key, 'user', incoming);
    return;
  }
  if (!passProbability(isGroup ? cfg.qq.groupReplyProbability : cfg.qq.privateReplyProbability)) {
    log('skip-probability', key);
    pushHistory(key, 'user', incoming);
    return;
  }

  const history = (histories.get(key) || []).map(({ role, content }) => ({ role, content }));
  const reply = await callLLM([
    { role: 'system', content: persona() },
    ...history,
    { role: 'user', content: incoming },
  ]);
  if (!reply || reply.includes('[[NO_REPLY]]')) {
    log('skip-no-reply', key);
    pushHistory(key, 'user', incoming);
    return;
  }

  const lines = reply
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, Number(cfg.qq.maxLinesPerReply || 6));
  if (!lines.length) return;

  const delayRange = isGroup
    ? (cfg.qq.groupReplyDelaySec || cfg.qq.replyDelaySec)
    : (cfg.qq.privateReplyDelaySec || cfg.qq.replyDelaySec);
  await sleep(randBetween(delayRange));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isGroup) {
      await onebot('send_group_msg', { group_id: Number(ev.group_id), message: [{ type: 'text', data: { text: line } }] });
    } else {
      await onebot('send_private_msg', { user_id: Number(ev.user_id), message: [{ type: 'text', data: { text: line } }] });
    }
    log('sent', key, `(${i + 1}/${lines.length})`, line.slice(0, 120));
    if (i < lines.length - 1) await sleep(randBetween(cfg.qq.lineIntervalSec));
  }
  pushHistory(key, 'user', incoming);
  pushHistory(key, 'assistant', lines.join('\n'));
}

let ws;
function connect() {
  cfg = loadConfig();
  const base = cfg.qq.onebotWs.replace(/\/$/, '');
  const url = base + '/?access_token=' + encodeURIComponent(cfg.qq.token);
  log('connecting', url.replace(/access_token=.*/, 'access_token=***'));
  ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + cfg.qq.token } });
  ws.on('open', () => log('onebot ws open'));
  ws.on('message', (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    handleMessage(ev).catch((e) => log('handle error:', e.message));
  });
  ws.on('close', (code, reason) => {
    log('onebot ws close', code, String(reason || ''));
    setTimeout(connect, 3000);
  });
  ws.on('error', (err) => {
    log('onebot ws error:', err.message);
    try { ws.close(); } catch {}
  });
}

connect();
process.on('SIGINT', () => { log('SIGINT'); try { ws?.close(); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM'); try { ws?.close(); } catch {}; process.exit(0); });
