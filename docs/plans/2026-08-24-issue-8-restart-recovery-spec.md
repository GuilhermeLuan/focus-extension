# Issue #8 — Recuperar e reconciliar um Pomodoro após reinício

- **Issue:** [#8 — Recover and reconcile an active Pomodoro after restart](https://github.com/GuilhermeLuan/focus-extension/issues/8)
- **Status:** refinada e pronta para implementação
- **Dependências obrigatórias:** #4 e #7, integradas em `457396c` e `fb90ed2`
- **Método:** TDD nos seams públicos; storage continua sendo a única autoridade

## Resultado esperado

Sempre que o background for criado, o navegador iniciar, a extensão for instalada/atualizada, um alarme conhecido disparar ou uma mensagem válida chegar, o background reconcilia o estado persistido antes de executar a intenção do evento. A reconciliação não cria uma nova sessão: ela restaura efeitos derivados de uma sessão ainda válida ou conclui uma sessão expirada segundo o contrato da #7.

Uma sessão válida preserva exatamente `id`, `startedAt`, `cancelAllowedUntil`, `endsAt`, `durationMinutes` e `profileSnapshot`. O background agenda/substitui o alarme `pomodoro-expiration` no `endsAt` original e solicita o ícone ativo. Portanto, reiniciar durante os primeiros 60 segundos não reinicia a tolerância: o cancelamento continua permitido somente enquanto `now < cancelAllowedUntil`.

Uma sessão com `endsAt <= now` é concluída antes de qualquer comando continuar: o `StateStore` cria/reutiliza o aviso pendente da #7, remove `activeSession`, e o serviço solicita alarme limpo e ícone inativo. Uma sessão ausente também solicita esses dois efeitos inativos, sem criar aviso.

## Autoridade, ordem e gatilhos

`browser.storage.local` é a autoridade. Alarme, ícone e notificação são efeitos derivados e nunca alteram os timestamps da sessão.

Todos os gatilhos abaixo entram na mesma fila do `BackgroundService`:

1. reconciliação de bootstrap executada uma vez ao construir o background;
2. `browser.runtime.onStartup`;
3. `browser.runtime.onInstalled` — instalação e atualização usam a mesma regra;
4. `browser.alarms.onAlarm` para `pomodoro-expiration`;
5. toda mensagem cujo `type` pertença ao contrato `BackgroundRequest`, inclusive comandos de configuração, exportação, início e cancelamento.

Alarmes desconhecidos continuam sem ler ou alterar estado. Mensagens desconhecidas continuam retornando o erro existente e não ganham efeitos colaterais. O guard de navegação continua lendo o storage autoritativo para nunca bloquear uma sessão expirada; ele não precisa disparar APIs auxiliares.

Para um gatilho válido, executar logicamente dentro da região serializada:

1. capturar `now` uma única vez;
2. ler/canonicalizar o estado pelo `StateStore` nesse instante;
3. se a sessão expirou, persistir/reutilizar o aviso da #7 e remover `activeSession` antes dos efeitos;
4. reconciliar alarme e ícone com o estado resultante;
5. tentar avisos de conclusão pendentes conforme a #7;
6. somente então executar o comando, relendo o estado apenas quando a operação exigir uma decisão posterior própria.

O comando não pode operar sobre a sessão pré-reconciliação. Exemplos: `START_SESSION` depois de recuperar uma sessão válida responde `SESSION_ALREADY_ACTIVE`; depois de remover uma expirada pode iniciar uma nova; `CANCEL_SESSION` usa a janela original; uma mutação de perfil continua vendo o perfil bloqueado pela sessão recuperada.

## Casos temporais canônicos

Com uma sessão persistida, os limites são inclusivos/exclusivos exatamente assim:

- `now < cancelAllowedUntil < endsAt`: sessão ativa e ainda cancelável; nenhum timestamp muda;
- `cancelAllowedUntil <= now < endsAt`: sessão ativa e não cancelável; nenhum timestamp muda;
- `now === endsAt`: sessão expirada, removida antes de responder ou executar o comando;
- `now > endsAt`: mesmo resultado de expiração atrasada;
- sem `activeSession`: estado ocioso; limpar alarme conhecido e solicitar ícone inativo.

Sessões V1 sem `cancelAllowedUntil` continuam usando a migração canônica da #4, `startedAt + 60_000`, persistida uma vez. A recuperação nunca calcula a tolerância a partir de `now`.

## Falhas, retry e concorrência

- Falha em `alarms.create`, `alarms.clear`, `indicator.setActive` ou `indicator.setInactive` não remove nem recria sessão e não transforma um comando bem-sucedido em erro.
- Alarme e ícone são tentados independentemente; falha de um não impede a tentativa do outro.
- Uma sessão válida permanece persistida se o re-agendamento falhar. O próximo bootstrap, evento de lifecycle, alarme conhecido ou mensagem válida tenta novamente no mesmo `endsAt`.
- A entrega de aviso pendente mantém o retry e o ID determinístico definidos na #7. Não há promessa de notificação enquanto o navegador estiver fechado nem exatamente em `endsAt`; ao reabrir, a entrega continua best-effort.
- Eventos concorrentes são serializados na ordem em que entram na fila. Cada um relê o storage quando começa, de modo que não usa snapshots obsoletos, não duplica uma sessão e não remove uma sessão nova.
- Repetir qualquer reconciliação é idempotente do ponto de vista autoritativo. Repetir `alarms.create` com o mesmo nome/`when`, limpar um alarme ausente e reaplicar o mesmo ícone são efeitos permitidos.

## API e wiring esperados

Expor no serviço um método público de lifecycle, por exemplo `reconcile()`, que apenas enfileira a mesma rotina usada antes das mensagens e pelo alarme conhecido. O nome exato é detalhe de implementação; não duplicar lógica de recuperação no entrypoint.

O entrypoint registra `runtime.onStartup` e `runtime.onInstalled` e encaminha ambos para esse método, além de dispará-lo no bootstrap. Handlers devem usar `void` e deixar o serviço absorver falhas auxiliares; não criar listeners de tabs, timers periódicos ou novo estado em memória.

## Plano TDD e seams obrigatórios

Executar RED→GREEN por fatia, rodando o arquivo afetado e `npm run typecheck` regularmente:

1. **Recuperação válida:** pelo método público do serviço, uma sessão futura agenda exatamente `pomodoro-expiration` no `endsAt` original e solicita ícone ativo, sem writes em `activeSession`.
2. **Janela de cancelamento:** reinício em `cancelAllowedUntil - 1` permite apenas o milissegundo restante; em `cancelAllowedUntil` recusa; ambos preservam `startedAt`, `cancelAllowedUntil` e `endsAt`.
3. **Expirada/ausente:** em `endsAt` e depois, remove antes dos efeitos e devolve/segue com estado ocioso; ausência limpa alarme e solicita ícone inativo sem criar aviso.
4. **Falha e retry:** `alarms.create` rejeita na primeira reconciliação, a sessão permanece intacta e um evento posterior tenta o mesmo nome/`endsAt` novamente; cobrir independência entre alarme e ícone.
5. **Comando após reconciliação:** pelo menos `START_SESSION` cobre sessão válida recuperada versus sessão expirada removida; um comando de configuração prova que mensagens válidas também disparam retry antes de agir.
6. **Concorrência/idempotência:** bootstrap, mensagem e alarme concorrentes passam pela mesma fila, relêem storage e terminam com um único estado autoritativo e timestamps originais.
7. **Wiring Firefox:** extrair um seam pequeno e testável, se necessário, para provar que bootstrap, `onStartup` e `onInstalled` encaminham à mesma reconciliação; não testar implementação interna do WXT.

Usar relógio e promises controlados. Não testar pixels, passagem real do tempo, ordem interna entre os dois efeitos independentes ou detalhes privados.

## Critérios de aceite verificáveis

- [ ] Bootstrap, `runtime.onStartup` e `runtime.onInstalled` enfileiram a mesma reconciliação pública do serviço.
- [ ] Toda mensagem `BackgroundRequest` válida reconcilia o estado persistido antes de executar seu comando; mensagem e alarme desconhecidos preservam o comportamento sem efeitos.
- [ ] Sessão com `now < endsAt` agenda/substitui somente `pomodoro-expiration` em `endsAt`, solicita ícone ativo e preserva todos os campos/timestamps persistidos.
- [ ] Reinício em `cancelAllowedUntil - 1` não prolonga a janela; em `cancelAllowedUntil` o cancelamento já é recusado.
- [ ] Sessão com `now >= endsAt` é removida antes dos efeitos e antes do comando, usando o aviso persistente da #7; sessão ausente não cria aviso.
- [ ] Estado expirado ou ausente limpa `pomodoro-expiration`, solicita ícone inativo e não mantém sites bloqueados.
- [ ] Falha de re-agendamento mantém a sessão persistida e um gatilho válido posterior tenta novamente com o mesmo nome e `endsAt`.
- [ ] Falhas de alarme e ícone são independentes, não restauram/removem sessões e não mudam o resultado autoritativo do comando.
- [ ] Eventos concorrentes usam a fila única, relêem o storage ao iniciar e não duplicam/removem incorretamente sessões nem alteram seus timestamps.
- [ ] O comportamento best-effort de notificação da #7 é preservado, sem prometer entrega enquanto o navegador está fechado ou exatamente no término.
- [ ] Testes automatizados simulam reinício do event page/background e do navegador nos estados cancelável, não cancelável, expirado e ausente.
- [ ] `npm test`, `npm run typecheck` e `npm run build` passam.

## Fora de escopo

- polling, timers periódicos ou service worker persistente;
- alterar duração, início, término ou tolerância da sessão recuperada;
- mudanças no relógio do sistema enquanto o navegador está fechado;
- garantia de notificação do sistema enquanto o navegador está fechado ou permanentemente bloqueada;
- histórico, telemetria, múltiplos alarmes por sessão ou sincronização entre dispositivos;
- varrer/reabrir abas no recovery; o bloqueio de abas existentes continua pertencendo ao início da sessão (#6).

## Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar a issue nem fazer push.
- Implementar com TDD e commitar no branch atual.
- Revisar o diff final, como Sol, item a item contra os critérios acima.
- Relatar ciclos RED→GREEN, arquivos alterados e resultados exatos de teste, typecheck e build.
