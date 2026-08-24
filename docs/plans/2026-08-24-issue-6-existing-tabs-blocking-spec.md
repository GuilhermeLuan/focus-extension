# Issue #6 — Aplicar bloqueio a abas existentes e privadas

- **Issue:** [#6 — Apply active blocking to existing and private tabs](https://github.com/GuilhermeLuan/focus-extension/issues/6)
- **Status:** refinada e pronta para implementação
- **Dependência obrigatória:** #3 — início deliberado e snapshot da sessão (satisfeita por `1504f12`)
- **Método:** TDD em fatias verticais nos seams públicos definidos abaixo

## Resultado esperado

Quando `START_SESSION` cria uma sessão, o background persiste primeiro o snapshot autoritativo e somente depois examina todas as abas HTTP/HTTPS acessíveis à instalação. Cada aba cujo hostname corresponda ao perfil da nova sessão é redirecionada para a mesma página local e com os mesmos parâmetros usados pelo listener de navegação.

A enumeração não restringe janela, estado ativo, fixação, contexto privado ou container. Assim, uma única sessão global alcança abas em segundo plano, fixadas, em múltiplas janelas, privadas e com qualquer `cookieStoreId` que o Firefox exponha à extensão em modo `spanning`. Perfis separados do navegador e abas não expostas à instalação permanecem fora de escopo.

## Decisão de implementação

Adicionar um adapter injetável de abas existentes ao fluxo de início. A implementação Firefox consulta `browser.tabs.query({})`, avalia apenas tabs com `id` e `url` HTTP/HTTPS e reutiliza `decideNavigation` com o snapshot recém-persistido. Para cada decisão `redirect`, chama `browser.tabs.update(tab.id, { url: redirectUrl })`.

Somente `url` é alterada. A implementação não recria nem move a aba e não escreve `pinned`, `active`, `windowId`, `incognito` ou `cookieStoreId`; portanto, fixação, janela, plano de fundo e container permanecem os mesmos.

Alternativas rejeitadas:

1. Filtrar `tabs.query` por janela atual/aba ativa: não cobre o estado global pedido.
2. Duplicar correspondência de hostname na varredura: permite divergência em relação a redirects e refreshes futuros.
3. Content script: não cobre todas as abas e executa tarde demais.

## Ordem e consistência

Em um início válido:

1. Persistir `activeSession` com o snapshot do perfil.
2. Persistir as preferências selecionadas, conforme o contrato já existente de #3.
3. Reconciliar alarme e ícone ativo.
4. Varrer e redirecionar abas existentes usando o snapshot criado no passo 1.
5. Responder sucesso com a sessão ativa.

O seam de teste deve observar que a persistência da sessão terminou antes de o adapter de abas ser chamado. A varredura é best-effort: falha ao enumerar abas ou ao atualizar qualquer aba não remove a sessão, não volta o ícone ao estado inativo e não converte `START_SESSION` em erro. Atualizações são independentes (`Promise.allSettled`, ou comportamento equivalente), de modo que uma aba fechada ou inacessível não impede as demais.

O listener bloqueante já registrado em `webRequest.onBeforeRequest` continua sendo a autoridade para URL digitada, link, redirect e refresh. Seu filtro permanece limitado a HTTP/HTTPS e `main_frame`; `sub_frame`, imagens, scripts e demais sub-recursos continuam permitidos.

## Seams de teste acordados e plano TDD

Executar ciclos RED→GREEN verticais e rodar o arquivo afetado e `npm run typecheck` regularmente:

1. **Adapter de abas existentes:** pela interface pública do scanner, uma consulta sem filtros avalia abas de múltiplas janelas, privada, container, fixada e em segundo plano; somente URLs bloqueadas com `id` são atualizadas; cada update contém apenas `url`.
2. **Resiliência:** uma atualização rejeitada como `tab not found` não rejeita o scanner e não impede updates das outras abas; falha da consulta também é absorvida.
3. **Ordem no início:** pela interface pública `BackgroundService.handle(START_SESSION)`, o adapter observa `activeSession` já persistida e recebe exatamente o snapshot salvo.
4. **Sessão não revertida:** falha total ou parcial da varredura ainda retorna sucesso, mantém storage ativo e mantém a solicitação de ícone ativo.
5. **Navegação contínua:** pela função pública `decideNavigation`, `main_frame` bloqueado redireciona em navegação, redirect e refresh, enquanto `sub_frame` e sub-recursos permitem.
6. **Integração Firefox:** o entrypoint injeta `browser.tabs.query`/`browser.tabs.update` e usa a URL empacotada de `blocked.html`, sem adicionar novas permissões.

Não testar métodos privados, ordem interna além da fronteira persistência→scanner, pixels dos ícones ou detalhes internos do WXT.

## Critérios de aceite verificáveis

- [ ] `activeSession` está persistida antes da primeira consulta/atualização de abas.
- [ ] Ao iniciar, todas as abas HTTP/HTTPS acessíveis cujo hostname corresponda ao snapshot são redirecionadas para `blocked.html` com `hostname`, `sessionId` e `destination` corretos.
- [ ] A consulta não restringe janela, aba ativa, pin, privacidade ou container; testes incluem múltiplas janelas, aba em segundo plano, fixada, privada e com `cookieStoreId`.
- [ ] Cada update altera somente `url`; abas fixadas permanecem fixadas e as abas conservam janela/container.
- [ ] Abas sem `id`, sem URL, com URL inválida/não HTTP(S) ou hostname permitido não são atualizadas.
- [ ] Fechamento concorrente ou falha de uma aba não impede os demais redirects nem faz `START_SESSION` falhar.
- [ ] Falha de `tabs.query` não reverte a sessão persistida; navegações futuras continuam protegidas pelo listener.
- [ ] URL digitada, links, redirects e refreshes HTTP/HTTPS de `main_frame` permanecem bloqueados durante a sessão.
- [ ] Iframes (`sub_frame`) e demais sub-recursos permanecem permitidos.
- [ ] O início bem-sucedido usa o ícone ativo; cancelamento, expiração e estado ocioso usam o inativo.
- [ ] `npm test`, `npm run typecheck` e `npm run build` passam.

## Verificação manual no Firefox/Zen

Com permissão para janelas privadas habilitada, abrir antes do início: uma aba bloqueada fixada, outra em segundo plano, abas bloqueadas em duas janelas, uma aba em container e uma aba privada. Iniciar uma sessão e confirmar que todas vão à página bloqueada, que a fixada continua fixada e que container/janela não mudam. Em seguida validar URL digitada, link/redirect, refresh e um iframe incorporado.

## Fora de escopo

- solicitar ou reativar automaticamente a permissão privada;
- alcançar outro perfil do Firefox/Zen ou outra instalação da extensão;
- bloquear protocolos não HTTP/HTTPS, páginas privilegiadas, iframes ou sub-recursos;
- retry persistente ou telemetria de falhas de varredura;
- notificações de término ou redesign da página bloqueada;
- alterar CRUD, normalização ou snapshot de perfis.

## Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar a issue nem fazer push.
- Revisar o diff item a item contra os critérios acima.
- Relatar os ciclos RED→GREEN e os resultados exatos de teste, typecheck e build.
