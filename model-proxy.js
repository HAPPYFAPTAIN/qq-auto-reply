// 本地 OpenAI 兼容代理：给 wechat-relay / qq-onebot-relay 用
// 默认走 OpenCode（当前 OpenClaw 主用模型通道），也可用环境变量切到 deepseek/kimi
const http = require('http');

const PORT = Number(process.env.AUTO_REPLY_PROXY_PORT || 8899);
const DEFAULT_PROVIDER = (process.env.AUTO_REPLY_PROVIDER || 'opencode').toLowerCase();
const DEFAULT_MODEL = process.env.AUTO_REPLY_MODEL || 'deepseek-v4-flash';

const PROVIDERS = {
  opencode: {
    baseUrl: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1',
    apiKey: process.env.OPENCODE_API_KEY || '',
    model: process.env.OPENCODE_MODEL || DEFAULT_MODEL,
  },
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
  },
  kimi: {
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1',
    apiKey: process.env.KIMI_API_KEY || '',
    model: process.env.KIMI_MODEL || 'k3-256k',
  },
};

function pickProvider(model) {
  if (model && model.includes('/')) {
    const prefix = model.split('/')[0].toLowerCase();
    if (PROVIDERS[prefix]) return { name: prefix, cfg: PROVIDERS[prefix], model: model.slice(prefix.length + 1) };
  }
  const name = PROVIDERS[DEFAULT_PROVIDER] ? DEFAULT_PROVIDER : 'opencode';
  return { name, cfg: PROVIDERS[name], model: model || PROVIDERS[name].model || DEFAULT_MODEL };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 32 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const p = pickProvider();
      return sendJson(res, 200, { object: 'list', data: [{ id: p.model, object: 'model', owned_by: p.name }] });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'invalid json' } }); }
      const picked = pickProvider(body.model);
      if (!picked.cfg.apiKey) return sendJson(res, 500, { error: { message: `missing api key for provider ${picked.name}` } });
      const upstream = {
        ...body,
        model: picked.model,
        stream: false,
      };
      const resp = await fetch(picked.cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + picked.cfg.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upstream),
      });
      const text = await resp.text();
      res.writeHead(resp.status, {
        'Content-Type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(text);
    }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return sendJson(res, 200, { ok: true, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, port: PORT });
    }
    return sendJson(res, 404, { error: { message: 'not found' } });
  } catch (err) {
    return sendJson(res, 502, { error: { message: String(err && err.message || err) } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const p = pickProvider();
  console.log(`[model-proxy] listening http://127.0.0.1:${PORT}/v1 provider=${p.name} model=${p.model}`);
});
