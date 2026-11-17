// TriMeet - servidor de salas (Cloudflare Worker + Durable Object)
// Só apresenta os PCs uns aos outros. O vídeo e o áudio vão direto
// de PC para PC (ou pelo retransmissor TURN da Cloudflare, se precisar).

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
const cleanRoom = (r) => String(r || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/') return new Response('TriMeet ok', { headers: cors });

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
