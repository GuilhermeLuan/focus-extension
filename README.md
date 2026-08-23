# Focus Lock

Uma WebExtension Manifest V3 mínima para Firefox/Zen: salve um hostname e inicie um Pomodoro de 50 minutos. Durante a sessão, apenas navegações HTTP/HTTPS de aba principal para o hostname salvo ou seus subdomínios são redirecionadas para a página local de bloqueio.

## Desenvolvimento

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev:firefox
```

O estado é mantido em `browser.storage.local`; o background é a autoridade para configuração e sessão. A duração é fixa em 50 minutos nesta primeira versão.
