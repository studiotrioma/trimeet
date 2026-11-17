# TriMeet

Compartilhamento de tela entre amigos, direto de PC para PC (Electron + WebRTC).

- `app/` — código do app. `app/core/` é o "núcleo" que se atualiza sozinho; `app/main.js` só escolhe qual núcleo carregar.
- `servidor/` — Cloudflare Worker (salas por código + entrega das atualizações a partir desta pasta `update/`).
- `update/` — pacotes lidos pelo app (`latest.json` + `core-X.0.bin`).
- `tools/make_update.py` — gera um pacote novo: `python3 tools/make_update.py 3.0 "novidades"`, depois commit + push.

Versões: 2.0, 3.0, 4.0…
