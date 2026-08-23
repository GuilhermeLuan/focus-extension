# Issue #1 — Pomodoro básico com bloqueio de hostname

- **Issue:** [#1 — Block a configured hostname in a basic Pomodoro](https://github.com/GuilhermeLuan/focus-extension/issues/1)
- **Status:** especificação de implementação
- **Método:** TDD em fatias verticais (um teste RED, implementação mínima GREEN, então próximo comportamento)

## 1. Resultado esperado

Entregar uma WebExtension Manifest V3 executável no Firefox/Zen em que:

1. uma instalação nova possui um único perfil chamado `Foco`;
2. o popup permite salvar um hostname nesse perfil;
3. o popup permite iniciar uma única sessão de 50 minutos e consultar seu estado;
4. enquanto a sessão estiver ativa, navegações HTTP/HTTPS de aba principal para o hostname salvo ou seus subdomínios são redirecionadas para a página local de bloqueio;
5. iframes e demais sub-recursos nunca são bloqueados;
6. a página de bloqueio mostra hostname, perfil `Foco` e tempo restante, sem ação de desbloqueio.

## 2. Escopo fechado

### Incluído

- Projeto WXT com React, TypeScript estrito, Vitest e Manifest V3.
- Popup com um campo de hostname, ação `Salvar` e ação `Iniciar 50 min`.
- Persistência em `browser.storage.local` da configuração e da sessão ativa.
- Background como única autoridade para ler/escrever estado e iniciar sessão.
- Listener bloqueante de `browser.webRequest.onBeforeRequest` limitado a `main_frame`, `http://*/*` e `https://*/*`.
- Página empacotada de bloqueio.
- Expiração por `browser.alarms` e reconciliação por horário sempre que o estado é consultado ou uma requisição é avaliada.
- Testes automatizados dos critérios descritos na seção 7.
- Scripts de desenvolvimento, teste, typecheck e build documentados no README.

### Excluído

- múltiplos perfis, renomear/excluir perfil e página de opções;
- duração configurável, confirmação por pressionar, cancelamento e janela de 60 segundos;
- varredura ou redirecionamento de abas que já estavam abertas ao iniciar;
- notificações, ícones ativo/inativo, modo privado e checagem de permissão privada;
- importação/exportação, migrações genéricas e bibliotecas de Public Suffix List;
- bloqueio de IP, IPv6 ou `localhost`;
- estatísticas, histórico, telemetria, backend ou sincronização.

Não implementar esses itens “para preparar o futuro”.

## 3. Contratos de domínio

Persistir exatamente estas duas chaves superiores:

```ts
type StoredConfiguration = {
  schemaVersion: 1;
  profile: {
    id: "focus";
    name: "Foco";
    hostname: string | null;
  };
};

type ActiveSession = {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  endsAt: number;
  durationMinutes: 50;
  profileSnapshot: {
    id: "focus";
    name: "Foco";
    hostname: string;
  };
};

type ExtensionStorage = {
  configuration: StoredConfiguration;
  activeSession?: ActiveSession;
};
```

Valores iniciais:

- `configuration.schemaVersion = 1`;
- perfil `{ id: "focus", name: "Foco", hostname: null }`;
- nenhuma `activeSession`.

Uma leitura deve inicializar e persistir a configuração padrão quando ela ainda não existir. Sessão com `endsAt <= now` é expirada: deve ser removida antes de responder ao chamador.

## 4. Hostname e correspondência

O campo aceita um hostname, não uma URL completa.

Normalização ao salvar:

1. aplicar `trim`;
2. converter para minúsculas;
3. remover um único ponto final;
4. remover um único prefixo `www.`;
5. validar usando `new URL(`https://${candidate}`)` e exigir que o hostname retornado seja exatamente o candidato normalizado;
6. aceitar apenas nomes com ao menos um ponto e labels não vazias;
7. rejeitar porta, caminho, query, fragmento, credenciais, espaços, IPv4, IPv6 e `localhost`.

Exemplos:

- ` WWW.YouTube.com. ` → `youtube.com`;
- `news.example.com` → `news.example.com`;
- `https://example.com`, `example.com/path`, `localhost` e `127.0.0.1` → erro de validação.

Correspondência para uma URL HTTP/HTTPS válida:

```ts
requestHostname === configuredHostname ||
requestHostname.endsWith(`.${configuredHostname}`)
```

Assim, `youtube.com` bloqueia `youtube.com` e `m.youtube.com`, mas não `notyoutube.com` nem `youtube.com.example.org`.

## 5. Interface pública e mensagens

Popup e página bloqueada não acessam `storage.local` diretamente. Usar `browser.runtime.sendMessage` com três mensagens discriminadas:

```ts
type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "SET_HOSTNAME"; hostname: string }
  | { type: "START_SESSION" };
```

Respostas devem ser discriminadas e serializáveis:

```ts
type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: "INVALID_HOSTNAME" | "HOSTNAME_REQUIRED" | "SESSION_ALREADY_ACTIVE" | "STORAGE_ERROR" };
```

`GET_STATE` retorna configuração e a sessão ativa reconciliada. `SET_HOSTNAME` normaliza, valida, persiste e retorna o novo estado. `START_SESSION`:

1. reconcilia sessão expirada;
2. recusa se já houver sessão ativa;
3. recusa se o hostname for `null`;
4. cria uma sessão com snapshot, `startedAt = now` e `endsAt = now + 50 * 60_000`;
5. persiste a sessão antes de responder;
6. cria/substitui o alarme de expiração;
7. retorna o novo estado.

O background serializa as mensagens recebidas. Se dois `START_SESSION` chegarem simultaneamente, exatamente um retorna sucesso e o outro retorna `SESSION_ALREADY_ACTIVE`.

O relógio e a geração de ID devem ser dependências injetáveis no serviço de aplicação para testes determinísticos. Não criar uma framework de DI.

## 6. Bloqueio e interfaces visuais

Registrar listeners do background de forma síncrona no escopo superior.

O listener `onBeforeRequest` deve usar filtro:

```ts
{ urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }
```

e opção `["blocking"]`. Ao receber uma navegação:

- reconciliar/ler a sessão ativa;
- liberar se não houver sessão ou se o destino não corresponder;
- redirecionar correspondências para a URL empacotada da página de bloqueio;
- incluir somente `hostname` e `sessionId` como query params;
- em erro inesperado, liberar a navegação (`{}`), evitando bloqueio indefinido.

Embora o filtro real já exclua sub-recursos, a função de decisão testável deve receber o tipo da requisição e retornar `allow` para qualquer tipo diferente de `main_frame`. Isso fixa o critério de aceite sem testar detalhes de registro do browser.

### Popup

- Sempre exibe `Perfil: Foco`.
- Quando inativo: campo de hostname, `Salvar` e `Iniciar 50 min`.
- `Iniciar 50 min` fica desabilitado sem hostname salvo.
- Quando ativo: exibe hostname bloqueado e tempo restante calculado de `endsAt`; não oferece nova ação de início.
- Exibe erros curtos das respostas do background.

### Página de bloqueio

- Exibe o hostname vindo da query string apenas como texto.
- Consulta `GET_STATE` para obter perfil e `endsAt` autoritativos.
- Exibe `Foco` e tempo restante arredondado para cima em minutos/segundos.
- Não possui botão, link ou comando de desbloqueio.
- Se a sessão já expirou, informa que a sessão terminou; não redireciona automaticamente.

Não é necessário testar CSS em automação. Manter a UI simples, legível e funcional em tema claro/escuro.

## 7. Plano TDD obrigatório

Executar em ciclos verticais. Não escrever todos os testes antes da implementação.

1. **RED→GREEN — instalação/leitura inicial:** pela interface pública do repositório de estado, uma leitura sem dados devolve e persiste o perfil `Foco` com hostname `null`.
2. **RED→GREEN — configuração:** pelo serviço de mensagens/aplicação, `SET_HOSTNAME` normaliza um hostname válido e a leitura seguinte recupera o valor persistido; depois acrescentar rejeição de entradas inválidas.
3. **RED→GREEN — início:** com relógio/ID fixos, `START_SESSION` persiste uma sessão de exatamente 50 minutos com snapshot do hostname; acrescentar recusas para hostname ausente e sessão já ativa.
   Em seguida, enviar dois inícios concorrentes e garantir que somente um seja aceito.
4. **RED→GREEN — correspondência:** testar domínio exato, subdomínio e os dois falsos positivos (`notyoutube.com`, `youtube.com.example.org`).
5. **RED→GREEN — decisão de navegação:** com sessão ativa, `main_frame` HTTP/HTTPS correspondente produz redirect para página local com hostname/sessionId; `sub_frame`, imagem/script, host diferente e protocolo não HTTP(S) produzem allow.
6. **RED→GREEN — expiração:** uma consulta após `endsAt` remove a sessão persistida e devolve estado inativo; o handler do alarme usa a mesma reconciliação.
7. **GREEN final/refactor:** montar popup e página bloqueada sobre os contratos já cobertos; extrair somente duplicação evidente; rodar toda a suíte, typecheck e build.

Preferir testes de integração leves por interfaces públicas. Mockar apenas a fronteira `browser.storage.local`, `browser.alarms` e URL de runtime. Não testar funções privadas, ordem de chamadas internas, classes específicas nem estrutura de componentes.

## 8. Critérios de aceite verificáveis

- Em storage vazio, `GET_STATE` cria e retorna o perfil `Foco`.
- Após salvar `YouTube.com`, nova leitura retorna `youtube.com`.
- Ao iniciar, a sessão persistida termina exatamente 3.000.000 ms depois e o popup a exibe.
- Uma segunda tentativa durante a sessão retorna `SESSION_ALREADY_ACTIVE` sem alterar a sessão existente.
- Duas tentativas simultâneas produzem exatamente um sucesso e um `SESSION_ALREADY_ACTIVE`.
- Durante a sessão, `https://youtube.com/watch` e `https://m.youtube.com/` em `main_frame` redirecionam antes da página remota ser exibida.
- `sub_frame`, imagens, scripts e outros sub-recursos são liberados.
- Hostnames parecidos que não são o domínio nem subdomínio são liberados.
- A página bloqueada mostra hostname, `Foco` e tempo restante, sem desbloqueio.
- Após `endsAt`, o estado fica inativo e a navegação volta a ser liberada.
- `npm test`, `npm run typecheck` e `npm run build` passam.
- `npm run dev:firefox` inicia o modo de desenvolvimento do WXT para Firefox.

## 9. Entrega

- Código, testes e README no repositório.
- Nenhum commit, push, comentário ou fechamento da issue sem solicitação explícita.
- Preservar alterações preexistentes não relacionadas, inclusive arquivos `.DS_Store` já modificados/não rastreados.
- Ao concluir, relatar arquivos alterados, ciclos RED→GREEN executados e resultados exatos de teste/typecheck/build.
