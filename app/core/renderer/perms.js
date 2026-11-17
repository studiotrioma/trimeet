// TriMeet - administrador, cargos e permissões (estilo Discord)
// Confiança por assinaturas Ed25519 (tweetnacl): o estado do servidor só é
// aceito se assinado pelo dono ou por quem tem o cargo certo. Tudo circula
// pelo saguão; não há lógica no servidor.
'use strict';
(() => {
  const OWNER = '3XRr9K2Ctw5ehF0uGPauH9EuzWTA4zc0diQFmQmQWRY=';
  const PERMS = [
    { k: 'manageChannels', label: 'Gerenciar salas', ic: 'speaker' },
    { k: 'moveMembers', label: 'Mover pessoas', ic: 'user' },
    { k: 'manageRoles', label: 'Gerenciar cargos', ic: 'gear' },
    { k: 'seeAllChannels', label: 'Ver todas as salas', ic: 'eye' },
  ];
  const COLORS = ['#ff9f5a', '#64a8ff', '#4fd1a5', '#c792ff', '#ff6b8b', '#ffd166', '#5ee0e0', '#a3e635'];
  const LOCK = '<svg class="ic" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const CROWN = '<svg class="ic" viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>';

  // ---------- utilitários ----------
  const u8 = (s) => new TextEncoder().encode(s);
  const b64 = (a) => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = (s) => { const r = atob(s); const a = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; };
  const canon = (o) => {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function verify(msgObj, sig, pub) {
    try { return nacl.sign.detached.verify(u8(canon(msgObj)), unb64(sig), unb64(pub)); } catch { return false; }
  }

  function baseDoc() {
    return {
      v: 0, ts: 0, by: OWNER,
      roles: { everyone: { id: 'everyone', name: '@todos', color: '#8e8e93', order: 0, perms: { manageChannels: true, moveMembers: false, manageRoles: false, seeAllChannels: false } } },
      members: {},
      channels: {},
    };
  }

  function create() {
    let D = {};               // dependências (init)
    let cfg = {};
    let id = null;            // { pub, sec } minha identidade (ou a do dono, se ativado)
    let owner = false;
    let cur = { doc: baseDoc(), sig: '' };
    let prev = null;
    const known = {};         // nome -> pub anunciada na presença
    const usedMoves = new Set();
    let ready = false;

    // ---------- persistência ----------
    async function save() {
      try {
        const c = (await window.trimeet.loadConfig()) || {};
        c.identity = cfg.identity;
        if (cfg.ownerSeed) c.ownerSeed = cfg.ownerSeed; else delete c.ownerSeed;
        c.perms = { cur, prev };
        if (c.server && typeof c.server === 'object') delete c.server; // formato antigo (5.0/6.0)
        cfg = c;
        await window.trimeet.saveConfig({ ...c, _perms: true });
      } catch {}
    }

    function useOwnerSeed(seedB64) {
      const kp = nacl.sign.keyPair.fromSeed(unb64(seedB64));
      if (b64(kp.publicKey) !== OWNER) return false;
      id = { pub: OWNER, sec: b64(kp.secretKey) };
      owner = true;
      return true;
    }

    // ---------- permissões ----------
    function permsOfPub(pub, doc = cur.doc) {
      const p = { ...doc.roles.everyone.perms };
      if (pub === OWNER) { for (const x of PERMS) p[x.k] = true; return p; }
      for (const m of Object.values(doc.members)) {
        if (m.pub !== pub) continue;
        for (const rid of m.roles || []) {
          const r = doc.roles[rid];
          if (r) for (const x of PERMS) if (r.perms[x.k]) p[x.k] = true;
        }
      }
      return p;
    }
    function nameMatches(name, doc = cur.doc) {
      // o cargo vale para o nome + a chave daquele PC
      const m = doc.members[name];
      if (!m) return false;
      const pub = name === D.myName?.() ? id?.pub : known[name];
      return !!pub && m.pub === pub;
    }
    function myRoleIds() {
      const me = D.myName?.();
      return nameMatches(me) ? cur.doc.members[me].roles || [] : [];
    }
    function can(k) {
      if (owner) return true;
      const p = { ...cur.doc.roles.everyone.perms };
      for (const rid of myRoleIds()) { const r = cur.doc.roles[rid]; if (r && r.perms[k]) return true; }
      return !!p[k];
    }
    function hasAccess(chId) {
      if (owner || can('seeAllChannels')) return true;
      const a = cur.doc.channels[chId];
      if (!a) return true;
      const me = D.myName?.();
      // pessoa liberada pelo nome: precisa ser o mesmo PC registrado
      if ((a.members || []).includes(me) && nameMatches(me)) return true;
      return myRoleIds().some((r) => (a.roles || []).includes(r));
    }
    const access = (chId) => { const a = cur.doc.channels[chId]; return { restricted: !!(a && (a.restricted || a.hidden)), hidden: !!(a && a.hidden) }; };
    const canSee = (chId) => !access(chId).hidden || hasAccess(chId);
    const canJoin = (chId) => !access(chId).restricted || hasAccess(chId);

    // ---------- aceitar um estado assinado ----------
    function sameJSON(a, b) { return canon(a) === canon(b); }
    function permsSubset(p, of) { return PERMS.every((x) => !p[x.k] || of[x.k]); }
    function validAgainst(base, doc, sig) {
      if (!doc || typeof doc !== 'object' || typeof doc.v !== 'number' || !doc.roles || !doc.members || !doc.channels) return false;
      if (!doc.roles.everyone) return false;
      const { by } = doc;
      if (!by || !verify(doc, sig, by)) return false;
      if (by === OWNER) return true;
      const sp = permsOfPub(by, base);
      const rolesCh = !sameJSON(base.roles, doc.roles);
      const membersCh = !sameJSON(base.members, doc.members);
      const chCh = !sameJSON(base.channels, doc.channels);
      if ((rolesCh || membersCh) && !sp.manageRoles) return false;
      if (chCh && !sp.manageChannels) return false;
      // não pode criar/alterar/apagar cargo com poder que ele mesmo não tem
      const ids = new Set([...Object.keys(base.roles), ...Object.keys(doc.roles)]);
      for (const rid of ids) {
        const a = base.roles[rid], b = doc.roles[rid];
        if (sameJSON(a, b)) continue;
        if (a && !permsSubset(a.perms, sp)) return false;
        if (b && !permsSubset(b.perms, sp)) return false;
      }
      // não pode mexer nos próprios cargos
      for (const [n, m] of Object.entries({ ...base.members, ...doc.members })) {
        const a = base.members[n], b = doc.members[n];
        if (sameJSON(a, b)) continue;
        if ((a && a.pub === by) || (b && b.pub === by)) return false;
        // nem dar/tirar cargos com poder que ele não tem
        const changed = new Set([...(a?.roles || []), ...(b?.roles || [])].filter((r) => !(a?.roles || []).includes(r) || !(b?.roles || []).includes(r)));
        for (const r of changed) { const role = doc.roles[r] || base.roles[r]; if (role && !permsSubset(role.perms, sp)) return false; }
        void m;
      }
      return true;
    }
    function tryAccept(doc, sig) {
      if (doc.v > cur.doc.v) {
        if (!validAgainst(cur.doc, doc, sig)) return false;
        prev = cur; cur = { doc, sig };
        return true;
      }
      // empate (duas edições ao mesmo tempo): vence a assinatura "maior", se válida sobre o anterior
      if (doc.v === cur.doc.v && prev && sig > cur.sig && validAgainst(prev.doc, doc, sig)) { cur = { doc, sig }; return true; }
      return false;
    }

    // ---------- publicar uma mudança ----------
    function edit(fn) {
      if (!id) return false;
      const doc = clone(cur.doc);
      fn(doc);
      doc.v = cur.doc.v + 1; doc.ts = Date.now(); doc.by = id.pub;
      const sig = b64(nacl.sign.detached(u8(canon(doc)), unb64(id.sec)));
      if (!validAgainst(cur.doc, doc, sig)) { D.toast?.('Sem permissão para isso'); return false; }
      prev = cur; cur = { doc, sig };
      D.hubSend?.({ type: 'perm-state', doc, sig });
      save(); changed();
      return true;
    }
    function changed() { try { D.onChange?.(); } catch {} rerenderOpen(); }

    // ---------- mensagens do saguão ----------
    function onHubMessage(m) {
      if (!ready || !m || typeof m.type !== 'string') return;
      if (m.type === 'perm-state' && m.doc && typeof m.sig === 'string') {
        if (tryAccept(m.doc, m.sig)) { save(); changed(); }
        else if (m.doc.v < cur.doc.v && m.from && cur.doc.v > 0) D.hubSend?.({ type: 'perm-state', doc: cur.doc, sig: cur.sig, to: m.from });
      } else if (m.type === 'perm-move' && m.target === D.myName?.()) {
        const { target, ch, ts, by, sig } = m;
        const body = { type: 'perm-move', target, ch, ts, by };
        if (!by || !sig || usedMoves.has(sig)) return;
        if (Math.abs(Date.now() - ts) > 30000) return;
        if (!verify(body, sig, by)) return;
        if (!(by === OWNER || permsOfPub(by).moveMembers)) return;
        if (!canJoin(ch) && !(by === OWNER || permsOfPub(by).seeAllChannels)) return;
        usedMoves.add(sig);
        try { D.onMoveMe?.(ch, m.from); } catch {}
      }
    }
    function onHubPeerAdded(name) {
      if (ready && cur.doc.v > 0) D.hubSend?.({ type: 'perm-state', doc: cur.doc, sig: cur.sig, to: name });
    }
    function move(name, ch) {
      if (!id || !can('moveMembers')) return false;
      const body = { type: 'perm-move', target: name, ch, ts: Date.now(), by: id.pub };
      const sig = b64(nacl.sign.detached(u8(canon(body)), unb64(id.sec)));
      D.hubSend?.({ ...body, sig, to: name });
      return true;
    }

    // ---------- init ----------
    async function init(deps) {
      D = deps || {};
      ready = false;
      cfg = (await window.trimeet.loadConfig()) || {};
      if (cfg.identity && cfg.identity.pub && cfg.identity.sec) id = { ...cfg.identity };
      else {
        const kp = nacl.sign.keyPair();
        cfg.identity = { pub: b64(kp.publicKey), sec: b64(kp.secretKey) };
        id = { ...cfg.identity };
      }
      owner = false;
      if (cfg.ownerSeed) useOwnerSeed(cfg.ownerSeed);
      // estado guardado: só reaproveita se a assinatura ainda confere
      cur = { doc: baseDoc(), sig: '' }; prev = null;
      const sv = cfg.perms || (cfg.server && typeof cfg.server === 'object' ? cfg.server : null);
      if (sv && sv.cur && sv.cur.doc && sv.cur.sig && verify(sv.cur.doc, sv.cur.sig, sv.cur.doc.by)) {
        cur = sv.cur;
        if (sv.prev && sv.prev.doc && (sv.prev.sig === '' || verify(sv.prev.doc, sv.prev.sig, sv.prev.doc.by))) prev = sv.prev;
      }
      ready = true;
      await save();
      changed();
    }

    // ---------- interface ----------
    const I = (n) => (D.icon ? D.icon(n) : '');
    const orb = (n) => (D.orbHTML ? D.orbHTML(n) : '');
    let open = null; // { kind, arg, el, render }

    function modal(title, iconHTML, cls) {
      closeModal(true);
      const root = document.createElement('div');
      root.className = 'modal pm-modal';
      root.innerHTML = `<div class="modal-card glass pm-card ${cls || ''}" data-glass="28">
        <div class="pm-head"><span class="pm-title">${iconHTML}<b></b></span><button class="btn icon ghost pm-x" title="Fechar">${I('x')}</button></div>
        <div class="pm-body"></div></div>`;
      root.querySelector('.pm-title b').textContent = title;
      root.querySelector('.pm-x').onclick = () => closeModal();
      root.addEventListener('mousedown', (e) => { if (e.target === root) closeModal(); });
      document.body.appendChild(root);
      try { window.LiquidGlass?.observe(root); } catch {}
      return { root, body: root.querySelector('.pm-body') };
    }
    function closeModal(instant) {
      if (!open) return;
      const el = open.el; open = null;
      if (instant) { el.remove(); return; }
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 230);
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) closeModal(); });
    function rerenderOpen() { if (open) open.render(); }

    function knownNames() {
      const me = D.myName?.();
      const s = new Set([...Object.keys(cur.doc.members), ...Object.keys(known)]);
      if (me) s.add(me);
      return [...s].sort((a, b) => a.localeCompare(b));
    }
    function rolesSorted() { return Object.values(cur.doc.roles).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }
    function rolesOf(name) {
      if (!nameMatches(name)) return [];
      const m = cur.doc.members[name];
      const out = (m?.roles || []).map((r) => cur.doc.roles[r]).filter(Boolean).sort((a, b) => a.order - b.order).map((r) => ({ name: r.name, color: r.color }));
      return out;
    }
    function isOwnerName(name) { return name === D.myName?.() ? owner : known[name] === OWNER; }

    // --- Servidor: cargos + membros + modo dono ---
    function openServer() {
      const { root, body } = modal('Servidor', I('gear'), 'pm-wide');
      open = { kind: 'server', el: root, render: () => renderServer(body) };
      renderServer(body);
    }
    function renderServer(body) {
      const canRoles = can('manageRoles');
      const me = D.myName?.();
      let h = '';
      if (!owner) {
        h += `<div class="pm-owner"><span class="pm-crown">${CROWN}</span><input class="pm-code" type="password" placeholder="Código de dono" spellcheck="false" autocomplete="off"><button class="btn primary pm-act">Ativar</button></div>`;
      } else {
        h += `<div class="pm-owner on"><span class="pm-crown">${CROWN}</span><span>Você é o dono deste servidor</span></div>`;
      }
      h += `<div class="pm-sec"><span>Cargos</span>${canRoles ? `<button class="btn icon ghost sm pm-addrole" title="Novo cargo">${I('plus')}</button>` : ''}</div><div class="pm-roles">`;
      for (const r of rolesSorted()) {
        const ev = r.id === 'everyone';
        h += `<div class="pm-role" data-id="${esc(r.id)}">
          <button class="pm-dot" style="--rc:${esc(r.color)}" ${canRoles && !ev ? '' : 'disabled'} title="Cor"></button>
          <input class="pm-rname" value="${esc(r.name)}" maxlength="20" ${canRoles && !ev ? '' : 'disabled'} spellcheck="false">
          <div class="pm-perms">${PERMS.map((p) => `<label class="pm-perm ${r.perms[p.k] ? 'on' : ''}" title="${p.label}"><input type="checkbox" data-k="${p.k}" ${r.perms[p.k] ? 'checked' : ''} ${canRoles ? '' : 'disabled'}>${I(p.ic)}</label>`).join('')}</div>
          ${canRoles && !ev ? `<button class="btn icon ghost sm pm-del" title="Apagar cargo">${I('trash')}</button>` : '<span class="pm-sp"></span>'}
        </div>`;
      }
      h += `</div><div class="pm-legend">${PERMS.map((p) => `<span>${I(p.ic)}${p.label}</span>`).join('')}</div>`;
      h += `<div class="pm-sec"><span>Pessoas</span></div><div class="pm-people">`;
      for (const n of knownNames()) {
        const chips = isOwnerName(n) ? `<span class="pm-chip" style="--rc:#ffd166">${CROWN}Dono</span>` : rolesOf(n).map((r) => `<span class="pm-chip" style="--rc:${esc(r.color)}">${esc(r.name)}</span>`).join('');
        h += `<button class="pm-person" data-n="${esc(n)}">${orb(n)}<b>${esc(n)}${n === me ? ' <i>· você</i>' : ''}</b><span class="pm-chips">${chips}</span>${canRoles && n !== me ? I('pencil') : ''}</button>`;
      }
      h += `</div>`;
      body.innerHTML = h;
      // eventos
      const act = body.querySelector('.pm-act');
      if (act) {
        const inp = body.querySelector('.pm-code');
        const go = () => {
          const code = inp.value.trim();
          let ok = false;
          try { ok = useOwnerSeed(code); } catch { ok = false; }
          if (!ok) { inp.classList.add('bad'); D.toast?.('Código inválido'); setTimeout(() => inp.classList.remove('bad'), 600); return; }
          cfg.ownerSeed = code;
          save(); changed();
          D.toast?.('Modo dono ativado');
        };
        act.onclick = go;
        inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      }
      body.querySelector('.pm-addrole')?.addEventListener('click', () => {
        const rid = 'r' + Date.now().toString(36);
        edit((d) => {
          const order = Math.max(0, ...Object.values(d.roles).map((r) => r.order)) + 1;
          d.roles[rid] = { id: rid, name: 'Novo cargo', color: COLORS[order % COLORS.length], order, perms: { manageChannels: false, moveMembers: false, manageRoles: false, seeAllChannels: false } };
        });
        setTimeout(() => { const i = body.querySelector(`.pm-role[data-id="${rid}"] .pm-rname`); i?.focus(); i?.select(); }, 30);
      });
      for (const row of body.querySelectorAll('.pm-role')) {
        const rid = row.dataset.id;
        row.querySelector('.pm-dot').onclick = () => edit((d) => { const r = d.roles[rid]; r.color = COLORS[(COLORS.indexOf(r.color) + 1) % COLORS.length]; });
        const nm = row.querySelector('.pm-rname');
        const commit = () => { const v = nm.value.trim(); if (v && v !== cur.doc.roles[rid]?.name) edit((d) => { d.roles[rid].name = v.slice(0, 20); }); };
        nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); if (e.key === 'Escape') { nm.value = cur.doc.roles[rid].name; nm.blur(); } };
        nm.onblur = commit;
        nm.onchange = commit;
        for (const cb of row.querySelectorAll('.pm-perm input')) cb.onchange = () => { if (!edit((d) => { d.roles[rid].perms[cb.dataset.k] = cb.checked; })) renderServer(body); };
        row.querySelector('.pm-del')?.addEventListener('click', (e) => {
          const b = e.currentTarget;
          if (!b.classList.contains('confirm')) { b.classList.add('confirm'); b.title = 'Clique de novo para apagar'; setTimeout(() => b.classList.remove('confirm'), 2500); return; }
          edit((d) => {
            delete d.roles[rid];
            for (const m of Object.values(d.members)) m.roles = (m.roles || []).filter((x) => x !== rid);
            for (const c of Object.values(d.channels)) c.roles = (c.roles || []).filter((x) => x !== rid);
          });
        });
      }
      for (const b of body.querySelectorAll('.pm-person')) b.onclick = () => { if (can('manageRoles') && b.dataset.n !== me) openMember(b.dataset.n); };
    }

    // --- Cargos de uma pessoa ---
    function openMember(name) {
      const { root, body } = modal(name, `<span class="pm-orb">${orb(name)}</span>`);
      open = { kind: 'member', arg: name, el: root, render: () => renderMember(body, name) };
      renderMember(body, name);
    }
    function renderMember(body, name) {
      const pub = known[name] || cur.doc.members[name]?.pub;
      const my = owner ? null : permsOfPub(id.pub);
      const has = new Set(cur.doc.members[name]?.pub === pub ? cur.doc.members[name]?.roles || [] : []);
      const mayEdit = can('manageRoles') && name !== D.myName?.() && !!pub && !isOwnerName(name);
      let h = '';
      if (isOwnerName(name)) h += `<div class="pm-note">${CROWN}Dono do servidor</div>`;
      else if (!pub) h += `<div class="pm-note">${I('user')}Precisa estar online para receber cargos</div>`;
      else if (cur.doc.members[name] && cur.doc.members[name].pub !== pub) h += `<div class="pm-note warn">${I('user')}Outro PC usando este nome</div>`;
      h += '<div class="pm-checks">';
      for (const r of rolesSorted()) {
        if (r.id === 'everyone') continue;
        const allowed = mayEdit && (owner || permsSubset(r.perms, my));
        h += `<label class="pm-check ${has.has(r.id) ? 'on' : ''} ${allowed ? '' : 'off'}" style="--rc:${esc(r.color)}">
          <input type="checkbox" data-r="${esc(r.id)}" ${has.has(r.id) ? 'checked' : ''} ${allowed ? '' : 'disabled'}>
          <span class="pm-box">${I('check')}</span><span class="pm-dot2"></span><b>${esc(r.name)}</b>
          <span class="pm-mini">${PERMS.filter((p) => r.perms[p.k]).map((p) => I(p.ic)).join('')}</span></label>`;
      }
      if (rolesSorted().length <= 1) h += can('manageRoles') ? `<button class="btn primary pm-goserver">${I('plus')}Criar cargo</button>` : `<div class="pm-empty">Ainda não há cargos</div>`;
      h += '</div>';
      body.innerHTML = h;
      body.querySelector('.pm-goserver')?.addEventListener('click', () => { closeModal(); setTimeout(openServer, 240); });
      for (const cb of body.querySelectorAll('.pm-check input')) {
        cb.onchange = () => {
          const ok = edit((d) => {
            const m = d.members[name] && d.members[name].pub === pub ? d.members[name] : { pub, roles: [] };
            const set = new Set(m.roles || []);
            if (cb.checked) set.add(cb.dataset.r); else set.delete(cb.dataset.r);
            m.roles = [...set];
            m.pub = pub;
            d.members[name] = m;
          });
          if (!ok) renderMember(body, name);
        };
      }
    }

    // --- Acesso de uma sala ---
    function chName(chId) { return (D.channels?.() || []).find((c) => c.id === chId)?.name || 'Sala'; }
    function openChannel(chId) {
      const { root, body } = modal(chName(chId), I('speaker'));
      open = { kind: 'channel', arg: chId, el: root, render: () => renderChannel(body, chId) };
      renderChannel(body, chId);
    }
    function renderChannel(body, chId) {
      const a = cur.doc.channels[chId] || { restricted: false, hidden: false, roles: [], members: [] };
      const mayEdit = can('manageChannels');
      const dis = mayEdit ? '' : 'disabled';
      let h = `<label class="ctl pm-row"><span class="pm-ic">${LOCK}</span><span class="pm-rt"><b>Restrita</b><small>Só quem você escolher entra</small></span><input type="checkbox" class="switch" data-f="restricted" ${a.restricted || a.hidden ? 'checked' : ''} ${dis}></label>
        <label class="ctl pm-row"><span class="pm-ic">${I('eye-off')}</span><span class="pm-rt"><b>Oculta</b><small>Quem não tem acesso nem vê</small></span><input type="checkbox" class="switch" data-f="hidden" ${a.hidden ? 'checked' : ''} ${dis}></label>`;
      const on = a.restricted || a.hidden;
      h += `<div class="pm-sec ${on ? '' : 'dim'}"><span>Quem pode entrar</span></div><div class="pm-pick ${on ? '' : 'dim'}">`;
      for (const r of rolesSorted()) {
        if (r.id === 'everyone') continue;
        const sel = (a.roles || []).includes(r.id);
        h += `<button class="pm-tag ${sel ? 'on' : ''}" data-r="${esc(r.id)}" style="--rc:${esc(r.color)}" ${mayEdit && on ? '' : 'disabled'}><span class="pm-dot2"></span>${esc(r.name)}</button>`;
      }
      for (const n of knownNames()) {
        const sel = (a.members || []).includes(n);
        h += `<button class="pm-tag person ${sel ? 'on' : ''}" data-n="${esc(n)}" ${mayEdit && on ? '' : 'disabled'}>${orb(n)}${esc(n)}</button>`;
      }
      h += `</div>`;
      if (!mayEdit) h += `<div class="pm-note">${I('gear')}Só quem gerencia salas pode mudar</div>`;
      body.innerHTML = h;
      const upd = (fn) => { if (!edit((d) => { const c = d.channels[chId] || (d.channels[chId] = { restricted: false, hidden: false, roles: [], members: [] }); fn(c, d); if (!c.restricted && !c.hidden && !c.roles.length && !c.members.length) delete d.channels[chId]; })) renderChannel(body, chId); };
      for (const sw of body.querySelectorAll('.switch')) sw.onchange = () => upd((c) => {
        c[sw.dataset.f] = sw.checked;
        if (sw.dataset.f === 'hidden' && sw.checked) c.restricted = true;
        if (sw.dataset.f === 'restricted' && !sw.checked) c.hidden = false;
      });
      for (const t of body.querySelectorAll('.pm-tag')) t.onclick = () => upd((c, d) => {
        if (t.dataset.r) { const s = new Set(c.roles || []); s.has(t.dataset.r) ? s.delete(t.dataset.r) : s.add(t.dataset.r); c.roles = [...s]; }
        else {
          const n = t.dataset.n; const s = new Set(c.members || []);
          if (s.has(n)) s.delete(n); else {
            s.add(n);
            const pub = n === D.myName?.() ? id.pub : known[n];
            if (pub && !d.members[n]) d.members[n] = { pub, roles: [] }; // amarra o nome ao PC
          }
          c.members = [...s];
        }
      });
    }

    return {
      init,
      myPub: () => (owner ? OWNER : id?.pub) || '',
      notePresence(name, pub) { if (name && typeof pub === 'string' && pub.length > 20) { const was = known[name]; known[name] = pub; if (was !== pub) rerenderOpen(); } },
      onHubMessage, onHubPeerAdded,
      isOwner: () => owner,
      can, canSee, canJoin, access, rolesOf, isOwnerName,
      move,
      openServer, openMember, openChannel, close: () => closeModal(),
      _state: () => cur, // para testes
    };
  }

  window.TMPermsFactory = create;
  window.TMPerms = create();
})();
