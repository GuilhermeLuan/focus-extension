# Focus Lock

Uma WebExtension Manifest V3 para Firefox/Zen: gerencie perfis locais com regras de hostnames canônicas e inicie um Pomodoro de 50 minutos. Durante a sessão, apenas navegações HTTP/HTTPS de aba principal para os domínios do snapshot são redirecionadas para a página local de bloqueio.

## Desenvolvimento

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev:firefox
```

O estado é mantido em `browser.storage.local`; o background é a autoridade para configuração e sessão. A duração é fixa em 50 minutos nesta primeira versão.

Abra a página de opções para criar, selecionar, renomear e excluir perfis e para administrar as regras. O popup permite escolher o perfil, bloquear imediatamente o site da aba ativa e iniciar a sessão. Hostnames são convertidos para uma forma canônica (incluindo IDNA, IPv4, IPv6 e `localhost`); URLs HTTP/HTTPS também são aceitas.
