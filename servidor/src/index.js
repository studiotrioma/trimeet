// TriMeet - servidor de salas (Cloudflare Worker + Durable Object)
// Só apresenta os PCs uns aos outros. O vídeo e o áudio vão direto
// de PC para PC (ou pelo retransmissor TURN da Cloudflare, se precisar).

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
const cleanRoom = (r) => String(r || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

// ---------------------------------------------------------------------------
// Site: a mesma interface do app (app/core/renderer no GitHub), sempre na mesma versão.
// Quem entra pelo site precisa do código de convite (segredo INVITE_CODE no servidor).
// ---------------------------------------------------------------------------
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
const typeOf = (p) => TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const cleanPath = (p) => (/^[a-zA-Z0-9._\/-]+$/.test(p) && !p.includes('..') ? p : null);

async function fromRepo(env, path, { cacheTtl = 60 } = {}) {
  const base = env.WEB_BASE || String(env.UPDATES_BASE || '').replace(/\/update\/?$/, '');
  if (!base) return null;
  const r = await fetch(`${base}/${path}`, { cf: { cacheTtl, cacheEverything: true } });
  return r.ok ? r : null;
}
const page = (body, type, extra = {}) => new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extra } });

function sameText(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

async function serveWeb(req, url, env) {
  const p = url.pathname;
  if (req.method === 'POST' && p === '/web-auth') {
    let code = '';
    try { code = (await req.json()).code; } catch {}
    if (!env.INVITE_CODE || !code || !sameText(String(code).trim().toLowerCase(), String(env.INVITE_CODE).trim().toLowerCase())) {
      await new Promise((r) => setTimeout(r, 600)); // atrasa tentativas
      return json({ error: 'convite inválido' }, 403);
    }
    return json({ key: env.APP_KEY || '' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;

  if (p === '/' || p === '/index.html') {
    const r = await fromRepo(env, 'app/core/renderer/index.html');
    if (!r) return page('TriMeet ok', 'text/plain');
    let html = await r.text();
    html = html.replace('<head>', `<head>
  <base href="/app/" />
  <script src="/web/shim.js"></script>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icon.png" />
  <link rel="apple-touch-icon" href="/icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`);
    return page(html, TYPES.html);
  }
  if (p === '/version.json') {
    const r = await fromRepo(env, 'app/core/version.json', { cacheTtl: 30 });
    return r ? page(r.body, TYPES.json) : json({ version: null });
  }
  if (p === '/icon.png') {
    const r = await fromRepo(env, 'app/build/icon.png', { cacheTtl: 3600 });
    return r ? new Response(r.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } }) : null;
  }
  if (p === '/manifest.webmanifest') {
    return page(JSON.stringify({
      name: 'TriMeet', short_name: 'TriMeet', start_url: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000',
      icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
    }), 'application/manifest+json');
  }
  if (p === '/app/config.js') {
    // nunca entrega a chave do servidor para o site: ela vem do código de convite
    return page(`window.TRIMEET_CONFIG = { server: location.origin, key: localStorage.getItem('trimeet.key') || '' };`, TYPES.js);
  }
  let repoPath = null;
  if (p.startsWith('/app/')) repoPath = cleanPath(p.slice(5)) && 'app/core/renderer/' + p.slice(5);
  else if (p.startsWith('/web/')) repoPath = cleanPath(p.slice(5)) && 'web/' + p.slice(5);
  if (!repoPath) return null;
  const r = await fromRepo(env, repoPath);
  if (!r) return new Response('não encontrado', { status: 404 });
  return page(r.body, typeOf(repoPath));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    // ---- TriMeet no navegador (computador e celular) ----
    const web = await serveWeb(req, url, env);
    if (web) return web;

    // atualizações do app: vêm do repositório no GitHub (publicadas pelo Claude)
    if (url.pathname.startsWith('/update/')) {
      if (!env.UPDATES_BASE) return json({ error: 'sem atualizações' }, 404);
      const file = url.pathname.slice('/update/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
      const r = await fetch(`${env.UPDATES_BASE}/${file}`, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) return json({ error: 'não encontrado' }, 404);
      const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'no-store', ...cors } });
    }

    if (env.APP_KEY && url.searchParams.get('key') !== env.APP_KEY) return json({ error: 'chave inválida' }, 403);

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'esperado websocket' }, 426);
      const room = cleanRoom(url.searchParams.get('room'));
      if (room.length < 3) return json({ error: 'código de sala inválido' }, 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(req);
    }

    if (url.pathname === '/turn') {
      const stun = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: stun, turn: false });
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (!r.ok) return json({ iceServers: stun, turn: false, error: `turn ${r.status}` });
        const data = await r.json();
        // a porta 53 é bloqueada pelos navegadores; remove para não atrasar a conexão
        const iceServers = (data.iceServers || []).map((s) => ({
          ...s,
          urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
        }));
        return json({ iceServers, turn: true });
      } catch (e) {
        return json({ iceServers: stun, turn: false, error: String(e) });
      }
    }

    return json({ error: 'não encontrado' }, 404);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    // responde o "ping" sem acordar o objeto (economiza a cota grátis)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  nameOf(ws) {
    try { return ws.deserializeAttachment()?.name || null; } catch { return null; }
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === 1 && this.nameOf(w));
  }

  broadcastPeers(except) {
    const list = this.sockets(except);
    const peers = list.map((w) => this.nameOf(w));
    const msg = JSON.stringify({ type: 'peers', peers });
    for (const w of list) { try { w.send(msg); } catch {} }
  }

  webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 32) || 'Anônimo';
      // mesmo nome entrando de novo: derruba a sessão antiga
      for (const w of this.ctx.getWebSockets()) {
        if (w !== ws && this.nameOf(w) === name) { try { w.close(4000, 'replaced'); } catch {} }
      }
      ws.serializeAttachment({ name });
      ws.send(JSON.stringify({ type: 'welcome', name }));
      this.broadcastPeers();
      return;
    }

    const from = this.nameOf(ws);
    if (!from) return;
    const out = JSON.stringify({ ...msg, from });
    if (msg.to) {
      const target = this.sockets().find((w) => this.nameOf(w) === msg.to);
      if (target) { try { target.send(out); } catch {} }
    } else {
      for (const w of this.sockets(ws)) { try { w.send(out); } catch {} }
    }
  }

  webSocketClose(ws) {
    try { ws.close(); } catch {}
    this.broadcastPeers(ws);
  }

  webSocketError(ws) {
    this.broadcastPeers(ws);
  }
}
