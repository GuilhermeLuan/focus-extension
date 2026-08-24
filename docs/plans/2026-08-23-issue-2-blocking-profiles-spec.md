# Issue #2 — Perfis de bloqueio e hostnames canônicos

- **Issue:** [#2 — Manage blocking profiles and canonical hostnames](https://github.com/GuilhermeLuan/focus-extension/issues/2)
- **Status:** especificação de implementação
- **Base:** #1 concluída em `7d6b906`
- **Método:** TDD em fatias verticais nos seams públicos definidos na seção 8

## 1. Resultado esperado

Entregar a administração local de múltiplos perfis e listas de bloqueio. A página de opções deve permitir criar, selecionar, renomear e excluir perfis, além de adicionar e remover regras canônicas. O popup passa a selecionar um perfil, iniciar a sessão existente com o snapshot desse perfil e oferecer o atalho `Bloquear este site` quando não houver sessão ativa.

Todas as escritas continuam centralizadas no background e persistidas em `browser.storage.local`. Popup e opções refletem alterações observadas em `storage.onChanged`, sem reload. A sessão existente continua com duração fixa de 50 minutos; duração deliberada, confirmação de início e cancelamento pertencem à #3.

## 2. Abordagens consideradas

1. **Recomendado — domínio puro + comandos tipados no serviço:** normalização, correspondência e redundância ficam em funções puras; CRUD e proteção de sessão ficam no `BackgroundService`; React apenas apresenta estado e confirma consolidações. Mantém uma autoridade, permite TDD sem navegador e evita regras divergentes entre telas.
2. **CRUD direto nas telas:** menor diff inicial, mas viola a decisão arquitetural de que o background é a autoridade e introduz corridas entre popup/opções. Rejeitado.
3. **Persistir padrões de URL em vez de hosts canônicos:** simplifica a captura da aba, mas duplica regras equivalentes, torna IDNA/redundância imprevisíveis e conflita com o modelo aprovado. Rejeitado.

## 3. Escopo fechado

### Incluído

- migração do formato de perfil único criado pela #1 para o modelo de múltiplos perfis;
- tipos e comandos de CRUD, seleção, hostnames e `Bloquear este site`;
- normalização de hostname ou URL HTTP/HTTPS completa;
- validação por Public Suffix List com `tldts`;
- detecção de cobertura e consolidação confirmada;
- correspondência por sufixo somente para domínios e exata para IPv4, IPv6 e `localhost`;
- página de opções React registrada pelo WXT;
- seletor de perfil e atalho da aba atual no popup;
- atualização reativa das telas por mudanças no armazenamento;
- testes automatizados dos critérios da seção 8.

### Excluído

- duração configurável, confirmação de dois segundos, cancelamento e janela de 60 segundos (#3);
- importação/exportação, backup e restauração;
- varredura de abas já abertas, notificações e modo privado;
- estatísticas, sincronização, backend ou telemetria;
- redesign geral do popup ou da página bloqueada.

## 4. Modelo persistido e migração

```ts
type StoredConfiguration = {
  schemaVersion: 1;
  lastSelectedProfileId: string;
  lastDurationMinutes: 50;
  profiles: BlockingProfile[];
};

type BlockingProfile = {
  id: string;
  name: string;
  domains: BlockedHost[];
  createdAt: number;
  updatedAt: number;
};

type BlockedHost = {
  canonicalHost: string;
  displayHost: string;
  kind: "domain" | "ipv4" | "ipv6" | "localhost";
};

type ActiveSession = {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  endsAt: number;
  durationMinutes: 50;
  profileSnapshot: {
    id: string;
    name: string;
    domains: BlockedHost[];
  };
};
```

Instalação nova começa com um perfil vazio `Foco`, ID `focus`, e duração 50. Ao ler o formato legado `{ profile: { id, name, hostname } }`, o store o converte e persiste atomicamente no novo formato: mantém ID/nome e transforma o hostname existente em uma única regra de domínio. Nenhuma sessão legada ativa é descartada: seu snapshot de hostname é convertido em `domains` na leitura. A migração é idempotente.

IDs de novos perfis e timestamps entram como dependências injetáveis do serviço. O nome após `trim` deve ter 1–40 caracteres. Unicidade usa `trim`, normalização Unicode NFKC e lowercase; o texto persistido preserva a capitalização informada após trim.

## 5. Normalização, proteção e correspondência

`normalizeBlockedHost(input)` aceita hostname ou URL completa. Se não houver esquema, acrescenta `https://` somente para parsing. Rejeita esquema explícito diferente de HTTP/HTTPS, credenciais, entrada vazia, espaços internos e URL sem hostname. Caminho, query, fragmento e porta de uma URL HTTP/HTTPS são ignorados.

O hostname é convertido pelo parser de URL para ASCII/IDNA, lowercase e sem ponto final; remove-se um único `www.` inicial. Outros subdomínios são preservados. A classificação é:

- `localhost` → `localhost`;
- IPv4 canônico → `ipv4`;
- IPv6 canônico, persistido sem colchetes → `ipv6`;
- demais hosts → `domain`, exigindo domínio registrável segundo a Public Suffix List (`tldts`); um sufixo público isolado, label inválida ou host sem registrable domain é recusado.

`displayHost` preserva a forma legível normalizada fornecida pelo usuário quando ela representa o mesmo host; caso contrário usa `canonicalHost`.

A denylist protegida segue a lista publicada pelo MDN para Firefox: `accounts-static.cdn.mozilla.net`, `accounts.firefox.com`, `addons.cdn.mozilla.net`, `addons.mozilla.org`, `api.accounts.firefox.com`, `content.cdn.mozilla.net`, `discovery.addons.mozilla.org`, `install.mozilla.org`, `oauth.accounts.firefox.com`, `profile.accounts.firefox.com`, `support.mozilla.org` e `sync.services.mozilla.com`. É recusada qualquer regra de domínio que seja igual, descendente ou ancestral de um desses hosts, pois poderia bloquear um host protegido. Protocolos internos (`about:`, `moz-extension:`, `file:`, `data:` etc.) são recusados antes do parsing de host.

Para `domain`, uma regra cobre igualdade e qualquer subdomínio delimitado por ponto. Para IPs e `localhost`, somente igualdade exata. O mesmo algoritmo é usado tanto na navegação quanto na análise de redundância.

## 6. CRUD, redundância e sessão ativa

Comandos públicos:

```ts
type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "CREATE_PROFILE"; name: string }
  | { type: "SELECT_PROFILE"; profileId: string }
  | { type: "RENAME_PROFILE"; profileId: string; name: string }
  | { type: "DELETE_PROFILE"; profileId: string }
  | { type: "ADD_BLOCKED_HOST"; profileId: string; input: string; confirmConsolidation?: boolean }
  | { type: "REMOVE_BLOCKED_HOST"; profileId: string; canonicalHost: string }
  | { type: "BLOCK_CURRENT_SITE"; url: string }
  | { type: "START_SESSION" };
```

Erros discriminam pelo menos nome inválido/duplicado, perfil inexistente, último perfil, perfil ativo bloqueado, host inválido/protegido, regra já coberta, confirmação necessária, URL atual indisponível, sessão ativa, perfil vazio e armazenamento. A resposta `CONFIRM_CONSOLIDATION` inclui as regras específicas que seriam removidas.

Adicionar uma regra já coberta não escreve e informa a regra existente. Adicionar domínio mais amplo retorna `CONFIRM_CONSOLIDATION` sem escrever. Repetir com `confirmConsolidation: true` adiciona a regra ampla e remove, na mesma gravação, todas as regras de domínio cobertas. IPs e `localhost` só são redundantes por igualdade.

O único perfil não pode ser excluído. Excluir o selecionado seleciona o perfil restante mais recentemente atualizado. Durante uma sessão, o perfil cujo ID está no snapshot não pode ser renomeado, excluído nem ter regras alteradas; outros perfis continuam editáveis. O perfil selecionado ainda pode mudar para preparar a próxima sessão. `START_SESSION` usa uma cópia profunda da lista do perfil selecionado e recusa perfil vazio.

## 7. Interfaces

A página de opções contém lista/seletor de perfis, criação, renomeação, exclusão com confirmação e contagem de regras, formulário de hostname/URL e remoção individual. Ao receber `CONFIRM_CONSOLIDATION`, mostra os hosts que serão absorvidos e só reenvia após confirmação explícita. Controles do perfil em sessão ficam somente leitura.

O popup remove o campo único de hostname. No estado inativo mostra seletor de perfil, quantidade de regras, `Bloquear este site`, link/botão para opções e o início de 50 minutos. `Bloquear este site` obtém a URL da aba ativa via `browser.tabs.query`, envia a URL ao background e a adiciona ao perfil selecionado; requer permissão `activeTab`. Durante sessão, o atalho fica desabilitado e o popup mostra nome/lista do snapshot sem permitir mutação.

Popup e opções registram `browser.storage.onChanged` e recarregam `GET_STATE` quando `configuration` ou `activeSession` mudar. A página bloqueada usa o nome do snapshot em vez de `Foco` fixo. Nenhuma tela escreve diretamente em storage.

## 8. Seams de teste acordados e ciclos TDD

Os testes observam somente interfaces públicas e usam literais independentes como resultado esperado. Mocks ficam apenas nas fronteiras de storage, relógio, IDs, alarmes e aba ativa.

1. **`normalizeBlockedHost` e `matchesBlockedHost`:** RED→GREEN para URL/hostname, `www`, ponto final, IDNA, subdomínio, IPv4, IPv6 e localhost; depois rejeições de protocolo, credenciais, PSL e denylist.
2. **Análise pública de inserção de regra:** RED→GREEN para igualdade, regra já coberta, confirmação de consolidação e separação entre domínio/IP/localhost.
3. **`BackgroundService.handle`:** fatias verticais para criar/selecionar/renomear/excluir; nomes inválidos/duplicados; último perfil; adicionar/remover; bloqueio do perfil da sessão; atalho de aba; snapshot do selecionado.
4. **`StateStore.read`:** instalação nova e migração idempotente do estado/snapshot legados.
5. **`decideNavigation`:** snapshot com várias regras, subdomínios, igualdade exata de IP/localhost e não correspondências.
6. **UI no limite necessário:** typecheck/build garantem contratos das entrypoints; lógica de negócio não é duplicada em testes de componentes.

Executar o arquivo de teste da fatia a cada ciclo, `npm run typecheck` regularmente, `npm test` completo uma vez ao final e `npm run build` antes da entrega.

## 9. Critérios de aceite verificáveis

- CRUD completo respeita unicidade NFKC/case-insensitive, tamanho 1–40, proteção do último perfil e proteção do perfil em sessão.
- Hostname ou URL HTTP/HTTPS adiciona/remover uma regra persistida no perfil correto.
- Casos de `www`, IDNA, ponto final, subdomínio, IPv4, IPv6 e localhost têm exemplos automatizados.
- Protocolos não HTTP/HTTPS, credenciais, sufixos públicos e hosts Firefox protegidos são recusados sem escrita parcial.
- Cobertura não duplica; consolidação exige confirmação e ocorre em uma única gravação.
- `Bloquear este site` usa o perfil selecionado, persiste imediatamente e fica indisponível durante sessão.
- Navegação consulta todas as regras do snapshot e mantém as semânticas domínio versus igualdade exata.
- Popup, opções e página bloqueada compilam; opções e popup reagem a alterações persistidas.
- Testes, typecheck e build Firefox MV3 passam.

