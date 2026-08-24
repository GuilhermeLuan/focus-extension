# Issue #4 — Cancelamento no período de tolerância

- **Issue:** [#4 — Cancel an active Pomodoro during the 60-second grace period](https://github.com/GuilhermeLuan/focus-extension/issues/4)
- **Status:** refinada e pronta para implementação
- **Base obrigatória:** #3, integrada em `1504f12`
- **Método:** TDD em fatias verticais; o background continua sendo a única autoridade

## 1. Resultado esperado

Uma sessão iniciada com sucesso pode ser cancelada somente quando `now < cancelAllowedUntil`, sendo `cancelAllowedUntil` fixado em `startedAt + 60_000`. O popup apenas apresenta essa possibilidade; o background relê a sessão persistida e decide. No instante exato do limite e depois dele, a sessão continua ativa e o cancelamento é recusado.

Quando aceita, o cancelamento remove a sessão, limpa o alarme de expiração e restaura a representação inativa da action da extensão. Páginas já redirecionadas para `blocked.html` percebem que a sessão que as bloqueou deixou de existir e oferecem retorno manual ao URL original. Não há recarga ou navegação automática de abas e não há notificação.

## 2. Contratos persistidos e de mensagens

`ActiveSession` passa a exigir:

```ts
type ActiveSession = {
  // campos existentes
  startedAt: number;
  cancelAllowedUntil: number; // sempre startedAt + 60_000
  endsAt: number;
};

type CancelSessionRequest = { type: "CANCEL_SESSION" };

type CancelSessionError =
  | "NO_ACTIVE_SESSION"
  | "CANCEL_WINDOW_CLOSED"
  | "STORAGE_ERROR";
```

O sucesso de `CANCEL_SESSION` usa o `BackgroundResponse<ExtensionState>` já existente e devolve estado sem `activeSession`.

Compatibilidade é obrigatória porque sessões criadas pelo código de #3 têm `schemaVersion: 1`, mas não têm o novo campo. Ao ler uma sessão V1 válida:

- calcular o valor canônico exclusivamente como `startedAt + 60_000`;
- preencher ou corrigir `cancelAllowedUntil` sem alterar `startedAt`;
- persistir a forma canônica uma única vez, de modo idempotente;
- aplicar a mesma regra à migração do formato legado.

Reabrir ou fechar o popup, reiniciar o background e reler o storage nunca recalculam a janela a partir do horário da leitura.

## 3. Regra autoritativa no background

`CANCEL_SESSION` participa da mesma fila que os demais comandos. Dentro da região serializada:

1. ler/reconciliar o estado persistido com o relógio injetado;
2. se não houver sessão, responder `NO_ACTIVE_SESSION` sem efeitos;
3. se `now >= cancelAllowedUntil`, responder `CANCEL_WINDOW_CLOSED` sem remover a sessão e sem limpar recursos;
4. se `now < cancelAllowedUntil`, remover `activeSession`;
5. limpar o alarme `pomodoro-expiration`;
6. definir a action/ícone da extensão como inativa;
7. responder sucesso com a mesma configuração e sem sessão.

O relógio deve ser capturado uma vez para a decisão. Em particular, `cancelAllowedUntil - 1` aceita e `cancelAllowedUntil` recusa.

O indicador da action terá um adapter injetável e duas representações empacotadas e visualmente distintas: ativa e inativa. O início bem-sucedido define a representação ativa; cancelamento e reconciliação de uma sessão ausente/expirada definem a inativa. Testes de serviço verificam chamadas ao adapter, não pixels. Falhas das APIs auxiliares após a remoção não recriam a sessão; a próxima reconciliação tenta restaurar o estado derivado novamente.

O cancelamento não chama APIs de tabs e não chama APIs de notifications. Não adicionar varredura, reload, update ou create de aba a esse caminho.

## 4. Popup

Extrair uma função pura para a apresentação temporal da sessão, usando a desigualdade estrita `now < cancelAllowedUntil`.

- enquanto cancelável, exibir botão habilitado com o rótulo `Cancelar sessão`;
- ao clicar, enviar exatamente um `CANCEL_SESSION` e desabilitar o botão enquanto aguarda;
- em sucesso, renderizar o estado ocioso retornado;
- no limite ou depois dele, não renderizar o botão e manter apenas a sessão bloqueada;
- se o background responder `CANCEL_WINDOW_CLOSED` por uma corrida entre render e clique, atualizar via `GET_STATE`, esconder o botão e mostrar uma mensagem curta;
- o timer visual existente atualiza tanto o tempo restante quanto a transição cancelável → bloqueada.

Nenhum estado local do popup cria ou prolonga a tolerância. Fechar e abrir o popup deriva a mesma janela do timestamp persistido.

## 5. Página bloqueada e destino original

O redirecionamento de navegação passa a incluir três parâmetros produzidos com `URLSearchParams`:

- `hostname` — apresentação atual;
- `sessionId` — ID da sessão que causou o bloqueio;
- `destination` — URL HTTP/HTTPS original completa, incluindo path, query e fragmento.

A página guarda os parâmetros da carga inicial. Ela está **bloqueada** somente enquanto o estado autoritativo contém uma sessão com o mesmo `sessionId`. Quando essa sessão desaparece (cancelamento ou conclusão) ou é substituída por outra, muda para o estado **liberado**, sem recarregar nem navegar.

No estado liberado:

- mostrar `A sessão terminou ou foi cancelada.`;
- mostrar um botão `Voltar ao site` somente se `destination` puder ser parseado e seu protocolo for `http:` ou `https:`;
- navegar para o destino apenas após ativação explícita do botão, por `window.location.assign`;
- um destino ainda bloqueado por uma nova sessão será naturalmente interceptado outra vez.

Parâmetro ausente, inválido ou com outro protocolo nunca é usado para navegação e não quebra a página.

## 6. Plano TDD e seams obrigatórios

Executar RED→GREEN por fatia, rodando o arquivo afetado e `npm run typecheck` regularmente:

1. **Modelo/storage:** criação inclui `cancelAllowedUntil`; sessão V1 anterior é canonicamente migrada e a segunda leitura não reescreve.
2. **Limites:** relógio falso prova sucesso em `startedAt + 59_999` e `CANCEL_WINDOW_CLOSED` em `startedAt + 60_000` e depois, preservando storage nos casos recusados.
3. **Efeitos:** sucesso limpa sessão/alarme e torna a action inativa; recusa não chama esses efeitos; início torna a action ativa.
4. **Concorrência:** duas solicitações de cancelamento serializadas produzem um sucesso e `NO_ACTIVE_SESSION`, sem efeitos duplicados.
5. **Popup:** função pura cobre `until - 1` e `until`; ligação envia uma vez e trata a corrida fechada.
6. **Navegação:** decisão de redirect preserva o destino original completo e codificado com segurança.
7. **Página bloqueada:** modelo puro cobre sessão correspondente, sessão ausente/substituída e validação HTTP/HTTPS do destino; UI só navega por ação manual.

Não testar detalhes de CSS, passagem real do tempo ou pixels. Usar relógio e timers controlados.

## 7. Critérios de aceite verificáveis

- [ ] Toda nova sessão persiste `cancelAllowedUntil === startedAt + 60_000`; sessões V1 anteriores são migradas sem reiniciar a janela.
- [ ] O popup mostra `Cancelar sessão` somente quando `now < cancelAllowedUntil` e não o mostra no limite ou depois.
- [ ] O background aceita em `cancelAllowedUntil - 1`, recusa com `CANCEL_WINDOW_CLOSED` em `cancelAllowedUntil` e depois, e recusa ausência com `NO_ACTIVE_SESSION`.
- [ ] Cancelamento aceito remove somente `activeSession`, preserva a configuração, limpa `pomodoro-expiration` e restaura a action inativa.
- [ ] Início define a action ativa; cancelamento e reconciliação sem sessão/expirada definem a action inativa.
- [ ] Duas tentativas concorrentes geram exatamente um sucesso e um `NO_ACTIVE_SESSION`, com limpeza executada uma vez.
- [ ] A página bloqueada muda para liberada quando a sessão capturada desaparece ou é substituída e oferece `Voltar ao site` para o destino HTTP/HTTPS original completo.
- [ ] Nenhum cancelamento recarrega/navega abas automaticamente nem emite notificação.
- [ ] Fechar/reabrir o popup ou reler o storage não altera `cancelAllowedUntil`.
- [ ] Testes usam relógio controlado e cobrem exatamente `until - 1` e `until`.
- [ ] `npm test`, `npm run typecheck` e `npm run build` passam.

## 8. Fora de escopo

- cancelamento após a tolerância, pausa ou extensão de sessão;
- alterações no relógio do sistema (limitação aceita da V1);
- histórico/estatísticas de cancelamento;
- retorno automático à página original;
- notificação de cancelamento;
- mudanças nas regras de correspondência de hostnames.

## 9. Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar a issue nem fazer push sem pedido explícito.
- Revisar o diff final, como Sol, item a item contra a seção 7.
- Relatar testes focados, suíte completa, typecheck e build.
