# Vagalume com servidor Node.js

    node server.js          # http://localhost:3000   (PORT=8080 node server.js para mudar a porta)

Sem dependências (Node 18+). Abra o endereço em dois aparelhos/abas, vá em Online → Criar sala e entre com o código.

- **Chat:** no lobby da sala e durante a partida (Enter, ou botão 💬 → "Escrever mensagem"; Esc fecha). A mensagem também vira balão sobre o herói.
- **Servidor:** `/ws` (WebSocket) retransmite posição/vida e o chat. Limites: 5 jogadores por sala, 120 caracteres, 5 mensagens a cada 5 s.
- Sem o servidor (arquivo local), o jogo continua usando PeerJS, e o chat funciona também nesse modo.

## Publicar no GitHub + Render
1. Suba o **conteúdo** desta pasta para a raiz do repositório (`package.json` e `server.js` precisam ficar na raiz, não dentro de uma subpasta, e não envie o .zip).
2. No Render: New → Web Service → escolha o repositório. Runtime **Node**, Build Command `npm install`, Start Command `npm start` (o `render.yaml` já traz isso).
3. Os jogadores abrem o endereço `https://seu-app.onrender.com`. O plano grátis dorme após inatividade; o primeiro acesso pode demorar ~1 min.
