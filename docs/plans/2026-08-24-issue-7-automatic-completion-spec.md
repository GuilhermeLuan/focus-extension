# Issue #7 — Concluir o Pomodoro e liberar páginas automaticamente

- **Issue:** [#7 — Finish a Pomodoro and release blocked pages automatically](https://github.com/GuilhermeLuan/focus-extension/issues/7)
- **Status:** refinada e pronta para implementação
- **Dependência obrigatória:** #3 — início deliberado e sessão persistida (satisfeita por `1504f12`)
- **Método:** TDD em fatias verticais nos seams públicos definidos abaixo

## Resultado esperado

Quando o relógio alcança `activeSession.endsAt`, a sessão deixa de existir no estado autoritativo antes de qualquer efeito auxiliar. O alarme de término é removido, o ícone volta ao estado inativo e páginas `blocked.html` já abertas detectam a remoção pelo listener de storage. Elas permanecem na página local e, quando a URL original é HTTP/HTTPS válida, oferecem o botão `Voltar ao site`; nunca navegam automaticamente.

Depois da liberação, o background emite uma notificação do sistema com o título `Pomodoro concluído`. A conclusão normal continua correta se o worker reiniciar, se o alarme atrasar, se outra leitura descobrir primeiro a expiração ou se a API de notificações falhar temporariamente. Cancelamento manual não é conclusão normal e não emite a notificação.

## Estado autoritativo e ordem obrigatória

`activeSession` persistida continua sendo a única autoridade para bloquear. `browser.alarms`, o ícone e notificações são efeitos derivados.

Ao observar uma sessão com `endsAt <= now`, executar logicamente nesta ordem:

1. persistir um aviso de conclusão pendente que identifica a sessão;
2. remover `activeSession` do storage;
3. reconciliar alarme e ícone com o estado ocioso;
4. tentar criar a notificação do aviso pendente;
5. remover o aviso somente após a API confirmar sucesso.

As etapas 1 e 2 podem ser duas operações de storage, desde que nenhum caminho tente notificar antes de `activeSession` ter sido removida. Se houver interrupção entre elas, a próxima reconciliação termina a remoção antes de notificar. A falha de alarme, ícone ou notificação nunca restaura a sessão nem impede a resposta ociosa.

Toda leitura usada pelo background ou pelo guard de navegação deve tratar uma sessão expirada como inativa. Assim, alarme atrasado, startup, `GET_STATE`, navegação e leitura feita pela página bloqueada não mantêm o bloqueio além de `endsAt`.

## Aviso de conclusão e idempotência

Persistir no storage interno um registro mínimo, por exemplo:

```ts
type PendingCompletionNotification = {
  schemaVersion: 1;
  sessionId: string;
  completedAt: number;
};
```

O nome exato do campo é detalhe de implementação, mas o registro deve sobreviver ao reinício do background e não faz parte de `ExtensionState` devolvido às UIs.

Regras:

- o aviso nasce apenas da expiração natural de uma sessão válida;
- `completedAt` corresponde ao `endsAt` persistido, não ao instante tardio em que o alarme executou;
- uma reconciliação repetida da mesma sessão reutiliza o mesmo aviso;
- o ID enviado à API é determinístico por sessão, no formato `pomodoro-completed:<sessionId>` ou equivalente estável;
- retry após sucesso da API seguido de interrupção substitui/reutiliza a mesma notificação do navegador, em vez de criar outra;
- aviso inválido no storage é descartado com segurança e nunca reativa bloqueio;
- `CANCEL_SESSION` remove apenas a sessão e não cria aviso de conclusão.

Se já houver aviso pendente e uma sessão ativa futura, o aviso anterior pode ser tentado sem alterar a nova sessão. O fluxo normal serializado do serviço não deve sobrescrever silenciosamente um aviso ainda não entregue.

## Contrato da notificação

Adicionar uma porta injetável no serviço, sem chamar `browser.notifications` diretamente na camada de aplicação. Conceitualmente:

```ts
type CompletionNotifier = {
  show(id: string, options: {
    title: "Pomodoro concluído";
    message: string;
  }): Promise<void>;
};
```

A implementação Firefox usa `browser.notifications.create` com:

- ID determinístico derivado do `sessionId`;
- `type: "basic"`;
- título exato `Pomodoro concluído`;
- mensagem curta informando que o período de foco terminou;
- ícone empacotado da extensão, se exigido pela API.

Adicionar a permissão `notifications` ao manifest. Clique e fechamento da notificação não executam ações nesta issue.

## Alarme, startup e concorrência

- `START_SESSION` agenda/substitui `pomodoro-expiration` em `endsAt`, como hoje.
- Somente esse nome de alarme dispara reconciliação de expiração; alarmes desconhecidos são ignorados.
- Um disparo adiantado mantém a sessão, reagenda para o mesmo `endsAt` e não notifica.
- Um disparo atrasado conclui uma única vez.
- Startup e `GET_STATE` reconciliam tanto sessão expirada quanto aviso pendente.
- Chamadas concorrentes continuam passando pela fila do serviço. Duas reconciliações não criam dois avisos lógicos, não removem uma sessão nova e não usam IDs diferentes.
- Falha da notificação conserva o aviso pendente; a próxima reconciliação tenta novamente.

## Página bloqueada

O contrato existente deve ser preservado e coberto:

- enquanto o `sessionId` capturado corresponde à sessão ativa, a página mostra o bloqueio;
- quando a sessão desaparece ou muda, mostra que a sessão terminou/cancelou;
- o listener de `browser.storage.onChanged` atualiza a página quando `activeSession` é removida;
- a página não chama `location.assign` automaticamente;
- `Voltar ao site` só aparece para o parâmetro `destination` HTTP/HTTPS validado;
- clicar no botão navega explicitamente à URL original completa;
- destino ausente, inválido ou de outro protocolo não produz botão/navegação.

Não é necessário abrir ou focar abas no término.

## Seams de teste e plano TDD

Executar ciclos RED→GREEN verticais, rodando o arquivo afetado e `npm run typecheck` regularmente:

1. **Registro de conclusão:** pelo `StateStore`, uma sessão em `endsAt` ou depois gera aviso com `sessionId`/`completedAt`, remove `activeSession` e leituras repetidas mantêm um único aviso.
2. **Liberação pelo alarme:** pelo `BackgroundService.handleAlarm`, expiração remove a sessão antes de o notifier ser chamado, limpa o alarme e solicita ícone inativo.
3. **Notificação normal:** conclusão chama o notifier com título e ID determinístico corretos; alarme adiantado, desconhecido e cancelamento não chamam.
4. **Falha e retry:** rejeição do notifier mantém sessão removida e aviso pendente; reconciliação posterior usa o mesmo ID e limpa o aviso após sucesso.
5. **Startup/leitura:** `GET_STATE` de sessão expirada devolve estado ocioso e tenta a notificação; aviso já pendente sem sessão também é retomado.
6. **Idempotência:** múltiplos alarmes/leituras não geram IDs diferentes e, depois de o aviso ser confirmado e removido, não chamam novamente.
7. **Página bloqueada:** funções puras cobrem sessão correspondente versus ausente/trocada e validação de destino; integração existente continua reagindo à remoção sem navegação automática.
8. **Integração Firefox:** entrypoint injeta `browser.notifications.create` e o manifest declara `notifications`.

Não testar métodos privados, pixels, implementação interna do WXT ou detalhes de timing do React além dos contratos públicos.

## Critérios de aceite verificáveis

- [ ] `START_SESSION` mantém exatamente um alarme `pomodoro-expiration` agendado em `activeSession.endsAt`.
- [ ] Em `endsAt` inclusive, a sessão é removida do storage antes da primeira tentativa de notificação.
- [ ] Após conclusão, o alarme é limpo e o ícone inativo é solicitado; falhas nesses efeitos não restauram o bloqueio.
- [ ] `GET_STATE`, startup, alarme atrasado e leitura de navegação tratam sessão expirada como inativa.
- [ ] Páginas bloqueadas detectam sessão removida/trocada e oferecem `Voltar ao site` somente para destino HTTP/HTTPS válido, sem navegar sozinhas.
- [ ] Conclusão natural cria notificação com título exato `Pomodoro concluído` e ID determinístico por sessão.
- [ ] Cancelamento, alarme adiantado/desconhecido e sessão ainda ativa não notificam.
- [ ] Falha de notificação não impede nem atrasa a remoção da sessão e deixa retry persistente para a próxima reconciliação.
- [ ] Retries usam o mesmo ID; após sucesso confirmado, novas reconciliações não chamam o notifier novamente.
- [ ] Reinício com aviso pendente retoma a tentativa sem reativar a sessão.
- [ ] O manifest contém a permissão `notifications`.
- [ ] Testes automatizados cobrem expiração, ordem de liberação, idempotência, retry e falha da notificação.
- [ ] `npm test`, `npm run typecheck` e `npm run build` passam.

## Verificação manual no Firefox/Zen

Iniciar uma sessão curta com uma aba bloqueada aberta, aguardar o horário final e confirmar: ícone inativo, página local muda sem redirecionar, botão retorna à URL original e aparece uma única notificação. Repetir fechando/reabrindo o background ou o navegador próximo do término e confirmar que a sessão é liberada e que o retry não cria notificações duplicadas visíveis.

## Fora de escopo

- som, ações, clique, botões ou personalização da notificação;
- histórico de Pomodoros, estatísticas, próxima sessão ou ciclos automáticos;
- alterar duração, confirmação de início, janela de cancelamento ou regras de hostname;
- varrer, fechar, focar ou navegar automaticamente abas no término;
- garantia de entrega se o usuário/sistema bloquear notificações permanentemente;
- telemetria ou fila genérica de eventos.

## Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar a issue nem fazer push.
- Implementar com TDD e commits no branch atual.
- Revisar o diff item a item contra os critérios acima.
- Relatar ciclos RED→GREEN, arquivos alterados e resultados exatos de teste, typecheck e build.
