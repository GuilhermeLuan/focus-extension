# Issue #3 — Início configurável e deliberado de um Pomodoro

- **Issue:** [#3 — Configure and deliberately start one Pomodoro](https://github.com/GuilhermeLuan/focus-extension/issues/3)
- **Status:** refinada e pronta para implementação
- **Dependência obrigatória:** #2 — perfis e hostnames canônicos (satisfeita por `ac7e0ae`)
- **Método:** TDD em fatias verticais, com o background como autoridade

## 1. Resultado esperado

Quando não existe sessão ativa, o popup permite selecionar exatamente um perfil existente e uma duração entre 5 e 180 minutos, em passos de 5. Antes do início, mostra um resumo com nome do perfil, duração, horário local de término e quantidade de hostnames. A sessão só é solicitada depois de o usuário manter pressionada a confirmação final por aproximadamente dois segundos.

O background não confia no popup: serializa comandos, relê o estado persistido, verifica permissão para janelas privadas, revalida perfil e duração e só então persiste uma sessão com cópia independente do perfil. Exatamente um de quaisquer inícios concorrentes pode vencer.

## 2. Pré-condição e limite da issue

A issue #2 está integrada no branch por `ac7e0ae` e oferece:

- `StoredConfiguration` com `profiles`, `lastSelectedProfileId` e hostnames canônicos por perfil;
- ao menos um perfil sempre existente;
- identificadores estáveis e nomes de perfil validados;
- lista de hostnames do perfil acessível ao serviço e à UI;
- navegação baseada no snapshot da sessão, não na configuração mutável.

Absorver novas mudanças de CRUD ou normalização nesta issue duplicaria o núcleo de #2 e tornaria impossível atribuir os testes às issues corretas.

## 3. Alternativas consideradas

### A. Integrar depois de #2 — escolhida

Adicionar apenas seleção, duração, confirmação deliberada, validações de início e snapshot sobre o contrato entregue por #2. É a menor mudança que respeita o grafo das issues e preserva revisão e rollback independentes.

### B. Criar nesta issue um schema intermediário de perfis

Permitiria programar sobre o branch atual, mas repetiria tipos, migração e persistência que pertencem a #2. Foi rejeitada por risco de incompatibilidade e trabalho descartável.

### C. Manter o perfil único da #1

Um seletor com uma única opção poderia aparentar cumprir parte da UI, mas não representaria o perfil selecionado/lista de hostnames definidos pelo produto e produziria um snapshot incompatível. Foi rejeitada.

## 4. Contratos

Os nomes exatos dos tipos de perfil devem acompanhar #2; conceitualmente, esta issue acrescenta:

```ts
type StartSessionRequest = {
  type: "START_SESSION";
  profileId: string;
  durationMinutes: number;
};

type ActiveSession = {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  endsAt: number;
  durationMinutes: number;
  profileSnapshot: {
    id: string;
    name: string;
    hostnames: CanonicalHostname[];
  };
};
```

O snapshot deve ser construído como nova estrutura, inclusive uma nova coleção de hostnames. Nenhuma referência mutável ao perfil da configuração pode ser preservada.

Erros discriminados do início:

```ts
type StartSessionError =
  | "PROFILE_REQUIRED"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_EMPTY"
  | "INVALID_DURATION"
  | "SESSION_ALREADY_ACTIVE"
  | "PRIVATE_PERMISSION_REQUIRED"
  | "STORAGE_ERROR";
```

`START_SESSION` recebe os dois valores escolhidos. O background nunca deduz o perfil ou a duração exclusivamente das preferências salvas.

## 5. Regras de início no background

Dentro da fila de comandos já existente, executar nesta ordem:

1. reconciliar uma possível sessão expirada;
2. recusar uma sessão ainda ativa;
3. exigir `profileId` string não vazia e localizar exatamente esse perfil;
4. recusar perfil inexistente ou sem hostnames;
5. exigir duração inteira, entre 5 e 180 inclusive e divisível por 5;
6. consultar `browser.extension.isAllowedIncognitoAccess()` pela dependência injetada e recusar quando `false`;
7. capturar `startedAt` uma vez, criar o snapshot e persistir a sessão;
8. persistir `lastSelectedProfileId` e `lastDurationMinutes` usados com sucesso;
9. criar/substituir o alarme de expiração e devolver o estado.

Falha de validação não escreve sessão nem preferências. Falha de storage é traduzida para `STORAGE_ERROR`. A ordem exata entre as validações 3–6 não faz parte do contrato público; testes verificam resultado e ausência de efeitos colaterais, não detalhes internos.

A serialização deve abranger todo o trecho leitura–validação–escrita. Dois comandos concorrentes com qualquer perfil/duração produzem exatamente um sucesso e um `SESSION_ALREADY_ACTIVE`, preservando a sessão vencedora.

## 6. Popup e confirmação deliberada

### Estado ocioso

- carregar o estado autoritativo via `GET_STATE`;
- selecionar `lastSelectedProfileId` quando ainda existir; caso contrário, o primeiro perfil;
- usar `lastDurationMinutes`, com fallback de 50;
- oferecer durações de 5 a 180 em incrementos de 5;
- desabilitar avanço quando nenhum perfil estiver selecionado.

### Estado de confirmação

Mostrar, antes do gesto final:

- nome do perfil;
- duração em minutos;
- horário local previsto de término;
- quantidade de hostnames (com singular/plural correto).

O horário previsto é calculado ao entrar na confirmação. Voltar à edição e confirmar novamente recalcula o valor. O horário autoritativo da sessão continua sendo `endsAt`, calculado pelo background quando o comando é aceito.

### Pressionar por dois segundos

O botão final começa a medir no `pointerdown` primário e envia `START_SESSION` uma única vez ao alcançar 2.000 ms. `pointerup`, `pointercancel`, `pointerleave`, perda de foco ou desmontagem antes do limiar cancelam o timer e zeram o progresso. Teclado oferece comportamento equivalente: `keydown` sustentado em Space/Enter começa; `keyup` cancela. Repetição automática de tecla não cria timers adicionais.

Enquanto a solicitação está em andamento, o controle fica desabilitado. A resposta de erro mantém o resumo para correção/retentativa e exibe mensagem curta. Sucesso troca para a visualização da sessão ativa já existente.

O progresso visual deve comunicar o gesto, mas CSS e animação não são critério automatizado. Respeitar `prefers-reduced-motion`.

## 7. Seams de teste e plano TDD

Executar um ciclo RED→GREEN por fatia, rodando o arquivo de teste afetado e `npm run typecheck` regularmente:

1. **Duração:** `START_SESSION` aceita 5, 50 e 180; recusa abaixo/acima, frações e valores fora do passo de 5 sem escrever.
2. **Perfil:** recusa ID vazio, perfil inexistente e perfil sem hostnames; um perfil válido é aceito.
3. **Permissão privada:** dependência injetada retorna `false` e impede qualquer escrita; `true` permite continuar; rejeição inesperada vira `STORAGE_ERROR`.
4. **Snapshot e preferências:** relógio/ID fixos demonstram `endsAt`, duração, cópia do perfil e atualização das duas preferências após sucesso. Alterar a configuração em seguida não altera a sessão persistida.
5. **Concorrência:** duas chamadas simultâneas geram um sucesso e um `SESSION_ALREADY_ACTIVE`, uma única sessão e um único alarme efetivo.
6. **Resumo:** extrair um modelo/função pura da confirmação e testar nome, duração, término e contagem singular/plural.
7. **Hold:** extrair a máquina/controlador temporal do gesto com relógio/timers injetáveis; testar limiar de 1.999/2.000 ms, cancelamentos e emissão única. Não testar pixels ou detalhes de DOM.
8. **Integração:** ligar popup e background aos contratos cobertos, preservando a tela ativa.

No fim, rodar uma vez `npm test`, `npm run typecheck` e `npm run build`.

## 8. Critérios de aceite verificáveis

- O popup lista os perfis entregues por #2 e mantém exatamente um selecionado.
- As opções de duração são `5, 10, …, 180`, com 50 na primeira instalação.
- Após um início bem-sucedido, perfil e duração reaparecem no próximo estado ocioso.
- A confirmação mostra nome, duração, término e número de hostnames antes do início.
- Soltar/cancelar antes de 2.000 ms não envia comando; atingir o limiar envia uma vez.
- O serviço recusa perfil vazio/inexistente, duração inválida, sessão concorrente e permissão privada ausente sem criar sessão.
- A sessão contém uma cópia independente do perfil escolhido e sua lista de hostnames.
- Chamadas concorrentes nunca persistem mais de uma sessão.
- Testes automatizados cobrem todas as regras acima.
- `npm test`, `npm run typecheck` e `npm run build` passam.

## 9. Fora de escopo

- CRUD, normalização, redundância ou migração de perfis/hostnames da #2;
- solicitação automática da permissão privada (a API só permite verificar e orientar);
- cancelamento de sessão, janela cancelável, varredura de abas, ícones ou notificações;
- alteração das regras de correspondência de navegação;
- estatísticas, histórico ou ciclos automáticos.

## 10. Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar/comentar a issue nem fazer push sem pedido explícito.
- O diff deve ser revisado critério por critério contra a seção 8.
- Relatar ciclos RED→GREEN, arquivos alterados e resultados exatos da suíte, typecheck e build.
