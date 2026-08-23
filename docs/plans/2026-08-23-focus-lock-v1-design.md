# Focus Lock V1 — Especificação técnica

- **Status:** aprovado para planejamento de implementação
- **Data:** 2026-08-23
- **Nome:** Focus Lock (provisório)
- **Plataforma primária:** Zen Browser e Firefox no macOS
- **Distribuição inicial:** uso pessoal, com arquitetura compatível com futura publicação

## 1. Resumo

Focus Lock é uma WebExtension de foco que inicia uma sessão temporizada e impede a navegação de aba principal para domínios pertencentes a um perfil de bloqueio. O bloqueio começa imediatamente, alcança abas existentes e futuras e permanece ativo após reinícios do navegador. O usuário pode cancelar somente durante os primeiros 60 segundos; depois disso, a sessão termina apenas no horário definido.

A V1 funciona inteiramente no dispositivo, sem conta, servidor, sincronização ou telemetria. Perfis, preferências e sessão ativa são persistidos com `browser.storage.local`. A interface inclui popup, página de configurações e página de bloqueio.

## 2. Objetivos

1. Bloquear de modo confiável navegações HTTP/HTTPS de aba principal durante uma sessão.
2. Manter o bloqueio em todas as janelas, espaços de trabalho, containers e janelas privadas visíveis para a instalação atual.
3. Recuperar uma sessão ativa após reinício do Zen/Firefox ou reinício do background da extensão.
4. Oferecer perfis independentes de blocklist já na V1.
5. Permitir backup e restauração local por JSON versionado.
6. Manter a experiência rápida, calma e deliberada, reduzindo inícios acidentais.

## 3. Não objetivos da V1

- Bloqueio fora do Zen/Firefox ou entre perfis separados do navegador.
- Impedir desativação ou desinstalação da extensão.
- Resistir à alteração do relógio do macOS após reinício do navegador.
- Bloquear iframes, vídeos incorporados, imagens, scripts, APIs ou downloads.
- Ciclos automáticos de foco e descanso.
- Histórico, estatísticas, metas ou sequências de dias.
- Sincronização entre dispositivos.
- Onboarding, tutorial ou conteúdo educativo.
- Telemetria, analytics, conta ou comunicação com servidores.
- Badge com tempo restante, atalhos de teclado ou sons próprios.
- Suporte oficialmente validado para Windows ou Linux.

## 4. Decisões de arquitetura

### 4.1 Stack

- WXT como ferramenta de desenvolvimento e empacotamento.
- React para popup, configurações e página de bloqueio.
- TypeScript em modo estrito.
- Manifest V3.
- Background não persistente/event page como autoridade do domínio.
- Vitest para testes unitários e de integração do domínio.
- Zod, ou validador de schema equivalente, nas fronteiras de armazenamento e importação.

### 4.2 Estratégia de bloqueio escolhida

Usar `browser.webRequest.onBeforeRequest` com comportamento bloqueante e filtro limitado a `main_frame` para HTTP/HTTPS. Quando a navegação corresponder a um domínio do perfil ativo, o background retorna um redirecionamento para uma página empacotada da extensão.

Essa abordagem foi escolhida porque:

- intercepta a navegação antes que o site seja exibido;
- permite calcular regras a partir do snapshot da sessão ativa;
- preserva iframes e recursos incorporados, conforme o escopo definido;
- permite uma página de bloqueio própria com contexto da sessão e destino original.

Alternativas rejeitadas:

1. **Content script:** executa tarde demais e não cobre páginas privilegiadas.
2. **Declarative Net Request:** é viável, mas adiciona sincronização de regras dinâmicas e dificulta associar cada redirecionamento ao destino original. Pode ser reavaliado se medições indicarem custo relevante no listener.
3. **Alteração de DNS ou arquivo hosts:** está fora do sandbox de uma WebExtension e ampliaria o produto para um aplicativo nativo.

### 4.3 Autoridade e comunicação

O background é o único componente autorizado a iniciar, cancelar, concluir ou reconciliar sessões e a alterar perfis. Popup, configurações e página bloqueada enviam comandos tipados por `runtime.sendMessage` e recebem resultados discriminados. Nenhuma tela altera diretamente o estado persistido.

Todos os listeners que precisam acordar o background devem ser registrados de forma síncrona no escopo superior do entrypoint.

## 5. Componentes

### 5.1 Background

Responsabilidades:

- validar e serializar comandos de escrita;
- persistir configuração e sessão;
- interceptar navegações;
- varrer abas existentes no início de uma sessão;
- agendar e reconciliar o término;
- atualizar o ícone ativo/inativo;
- emitir notificação de conclusão;
- migrar schemas de armazenamento;
- responder consultas das interfaces.

### 5.2 Popup

Estados principais:

1. `idle`: seletor de perfil, seletor de duração e início.
2. `confirming`: resumo da sessão e botão pressionável por dois segundos.
3. `active-cancelable`: cronômetro e cancelamento disponível.
4. `active-locked`: cronômetro sem cancelamento.
5. `configuration-error`: erro curto para permissão privada ausente, perfil vazio ou armazenamento inválido.

O popup não contém gerenciamento completo de perfis nem textos de onboarding.

### 5.3 Página de configurações

Responsabilidades:

- criar, selecionar, renomear e excluir perfis;
- adicionar e remover domínios;
- importar e exportar configuração;
- exibir validações e confirmações destrutivas.

O perfil ativo fica somente para leitura. Outros perfis permanecem editáveis. Importação fica indisponível durante qualquer sessão ativa.

### 5.4 Página de bloqueio

Exibe:

- hostname bloqueado;
- nome do perfil ativo;
- tempo restante e horário de término;
- ações `Voltar` e `Fechar aba`.

Durante a sessão, não oferece desbloqueio. Após cancelamento ou término, muda para o estado liberado e habilita `Voltar ao site`, sem navegar automaticamente.

### 5.5 Biblioteca de domínio

Módulos puros e independentes da UI:

- normalização e correspondência de hostnames;
- modelos e schemas;
- máquina de estados derivada do tempo;
- validação e migração de armazenamento;
- importação/exportação;
- contratos de mensagens.

## 6. Modelo de dados

O armazenamento usa duas chaves superiores para impedir que backups incluam sessões transitórias.

```ts
type StoredConfigurationV1 = {
  schemaVersion: 1;
  lastSelectedProfileId: string;
  lastDurationMinutes: number; // 5..180, múltiplo de 5
  profiles: BlockingProfile[];
};

type BlockingProfile = {
  id: string;                 // UUID
  name: string;               // 1..40 caracteres
  domains: BlockedHost[];
  createdAt: number;          // epoch milliseconds
  updatedAt: number;
};

type BlockedHost = {
  canonicalHost: string;      // ASCII/IDNA, lowercase, sem ponto final
  displayHost: string;        // representação legível
  kind: "domain" | "ipv4" | "ipv6" | "localhost";
};

type ActiveSessionV1 = {
  schemaVersion: 1;
  id: string;                 // UUID
  startedAt: number;
  cancelAllowedUntil: number; // startedAt + 60_000
  endsAt: number;
  durationMinutes: number;
  profileSnapshot: {
    id: string;
    name: string;
    domains: BlockedHost[];
  };
};
```

Chaves:

```ts
type ExtensionStorage = {
  configuration: StoredConfigurationV1;
  activeSession?: ActiveSessionV1;
};
```

O snapshot impede que edições, migrações ou referências ausentes alterem retroativamente a proteção de uma sessão já iniciada.

### 6.1 Valores iniciais

- Perfil: `Foco`.
- Duração: 50 minutos.
- Blocklist: vazia.
- Primeiro uso: sem sessão ativa.

O perfil e a duração usados mais recentemente tornam-se os valores selecionados para a próxima sessão.

## 7. Máquina de estados da sessão

O estado não é persistido como enum; ele é derivado de `activeSession` e do relógio atual.

```text
IDLE
  └─ start ───────────────► ACTIVE_CANCELABLE
                               ├─ cancel (< 60 s) ─► IDLE
                               └─ tempo ≥ 60 s ────► ACTIVE_LOCKED
                                                       └─ tempo ≥ endsAt ─► IDLE
```

Regras:

- Apenas uma sessão pode existir por instalação.
- O bloqueio começa antes da varredura de abas: primeiro persiste-se a sessão, depois as abas são redirecionadas.
- O background valida a janela de cancelamento; esconder o botão na UI não é uma barreira de segurança.
- Reiniciar o navegador não reinicia nem pausa os 60 segundos.
- A expiração sempre libera o bloqueio, mesmo que a notificação falhe.
- O horário é baseado em epoch do sistema. Alterações manuais do relógio são uma limitação aceita.

## 8. Fluxos funcionais

### 8.1 Iniciar Pomodoro

1. Popup carrega a visão autoritativa do background.
2. Usuário escolhe um único perfil e uma duração válida.
3. Popup apresenta perfil, duração, fim exato, quantidade de domínios e aviso de bloqueio.
4. Usuário mantém o botão pressionado por dois segundos.
5. Background revalida:
   - inexistência de sessão ativa;
   - permissão para janelas privadas;
   - existência do perfil;
   - perfil não vazio;
   - duração entre 5 e 180 e múltipla de 5.
6. Background cria e persiste `activeSession` com snapshot.
7. Agenda alarme de término e altera o ícone para ativo.
8. Enumera todas as abas acessíveis, inclusive fixadas e privadas, e redireciona as correspondentes.
9. Navegações futuras passam pelo listener bloqueante.

Se qualquer validação ou escrita anterior ao passo 6 falhar, nenhuma sessão é iniciada.

### 8.2 Cancelar

1. Botão aparece enquanto `now < cancelAllowedUntil`.
2. Background revalida a condição usando o estado persistido.
3. Remove `activeSession`, cancela o alarme e restaura o ícone inativo.
4. Páginas bloqueadas detectam a liberação e oferecem retorno manual.
5. Nenhuma notificação é emitida.

### 8.3 Concluir

1. O alarme acorda o background no `endsAt`.
2. O reconciliador confirma que a sessão expirou.
3. Remove `activeSession`, limpa o alarme e restaura o ícone.
4. Emite uma única notificação do sistema: `Pomodoro concluído`.
5. Páginas bloqueadas oferecem retorno manual.

O ID da notificação é determinístico por sessão para evitar duplicatas em retries.

### 8.4 Recuperar após reinício

Em `runtime.onStartup`, `runtime.onInstalled` e antes de processar qualquer comando:

- sem sessão: garantir ícone inativo e ausência de alarme obsoleto;
- sessão não expirada: reagendar término, ativar ícone e manter bloqueio;
- sessão expirada: limpar estado e ícone sem prometer notificação retroativa.

Se o navegador estava fechado no momento do fim, nenhuma notificação é exibida naquele instante.

### 8.5 Bloquear uma navegação

1. Ignorar qualquer recurso que não seja `main_frame`.
2. Aceitar somente `http:` e `https:`.
3. Carregar/reconciliar sessão ativa.
4. Normalizar o hostname da requisição.
5. Verificar correspondência contra o snapshot.
6. Redirecionar para `blocked.html` com `sessionId` e destino original codificado.

Antes de `Voltar ao site`, a página bloqueada valida que o destino possui protocolo HTTP/HTTPS. Se outra sessão ativa ainda bloquear o destino, a nova tentativa será interceptada normalmente.

## 9. Regras de hostnames

### 9.1 Entrada e normalização

- Aceitar hostname ou URL completa.
- Adicionar `https://` apenas para realizar parsing quando não houver esquema.
- Rejeitar esquemas diferentes de HTTP/HTTPS.
- Remover espaços, ponto final e `www.` inicial.
- Converter para lowercase e representação ASCII IDNA canônica.
- Preservar subdomínios diferentes de `www`.
- Aceitar IPv4, IPv6 e `localhost`.
- Rejeitar credenciais embutidas na URL.
- Rejeitar páginas internas e hosts protegidos conhecidos do Firefox.

Para domínios públicos, usar uma biblioteca baseada na Public Suffix List, como `tldts`, para rejeitar sufixos públicos inválidos e evitar regras excessivamente amplas.

### 9.2 Correspondência

Domínios:

```ts
requestHost === blockedHost || requestHost.endsWith(`.${blockedHost}`)
```

IPs e `localhost` usam igualdade exata.

Exemplos:

| Regra | Bloqueia | Não bloqueia |
|---|---|---|
| `youtube.com` | `youtube.com`, `m.youtube.com` | `youtube-nocookie.com` |
| `news.example.com` | `news.example.com`, `a.news.example.com` | `example.com`, `shop.example.com` |
| `127.0.0.1` | `127.0.0.1` | `127.0.0.2` |

### 9.3 Redundância

- Regra já coberta por uma mais ampla: não adicionar e informar cobertura existente.
- Regra mais ampla adicionada sobre regras específicas: pedir confirmação e remover as redundantes.
- Comparações usam a forma canônica.

## 10. Perfis

- Exatamente um perfil é usado por sessão.
- Nomes têm 1–40 caracteres após trim.
- Nomes são únicos após normalização Unicode, trim e case folding.
- Perfil ativo não pode ser renomeado, alterado ou excluído.
- Outros perfis podem ser editados durante uma sessão.
- O único perfil existente não pode ser excluído.
- Exclusão exige confirmação e informa a quantidade de domínios.
- O perfil restante usado mais recentemente é selecionado após exclusão.
- `Bloquear este site` adiciona ao perfil selecionado e fica indisponível durante sessão ativa.
- Um perfil vazio não pode iniciar uma sessão.

## 11. Importação e exportação

### 11.1 Formato

```ts
type FocusLockBackupV1 = {
  kind: "focus-lock-backup";
  schemaVersion: 1;
  exportedAt: string; // ISO 8601
  configuration: StoredConfigurationV1;
};
```

- Nome sugerido: `focus-lock-backup-YYYY-MM-DD.json`.
- Nunca incluir `activeSession`.
- Gerar JSON UTF-8 legível e determinístico.
- Não exigir a permissão `downloads`; a página de configurações pode gerar um Blob local.

### 11.2 Importação

1. Recusar enquanto houver sessão ativa.
2. Limitar tamanho do arquivo a 1 MiB.
3. Fazer parse e validação completa antes de qualquer escrita.
4. Migrar somente versões explicitamente suportadas.
5. Mostrar resumo do conteúdo.
6. Confirmar substituição completa.
7. Gerar backup preventivo da configuração atual.
8. Substituir `configuration` em uma única escrita.

Arquivo inválido, versão futura ou falha de backup não altera os dados atuais.

## 12. Permissões

Permissões previstas:

```json
{
  "permissions": [
    "alarms",
    "notifications",
    "storage",
    "webRequest",
    "webRequestBlocking"
  ],
  "host_permissions": [
    "http://*/*",
    "https://*/*"
  ]
}
```

Requisitos adicionais:

- navegação privada em modo `spanning` padrão do Firefox;
- `browser.extension.isAllowedIncognitoAccess()` deve retornar `true` antes do início;
- nenhuma permissão para cookies, histórico, conteúdo de formulários ou rede externa;
- não usar scripts remotos.

Se a permissão privada for revogada durante a sessão, a sessão permanece ativa e continua bloqueando onde a extensão ainda possui acesso. A UI apresenta erro técnico; uma WebExtension não pode reativar essa permissão por conta própria.

## 13. Concorrência e consistência

- Comandos mutáveis passam por uma fila assíncrona no background.
- Cada comando relê o estado persistido antes de validar e escrever.
- A criação de sessão usa regra `check-then-set` serializada.
- Interfaces usam IDs de comando para ignorar respostas obsoletas.
- `storage.onChanged` atualiza popup, configurações e páginas bloqueadas.
- Estado visual otimista não pode confirmar início, cancelamento ou importação antes da resposta do background.

Como a fila em memória desaparece com o event page, a consistência durável depende de operações idempotentes e da releitura de `storage.local`, não da vida do processo.

## 14. Tratamento de erros

| Falha | Comportamento |
|---|---|
| Escrita falha ao iniciar | Não iniciar; manter sites liberados; mostrar erro |
| Alarme não pode ser criado | Manter sessão persistida, tentar reagendar e reconciliar em eventos seguintes |
| Notificação falha | Sessão termina normalmente |
| Importação inválida | Preservar configuração atual e mostrar erros de validação |
| Configuração corrompida sem sessão | Recuperar configuração inicial, preservando cópia de diagnóstico quando possível |
| Sessão corrompida | Falhar de forma segura para o usuário: remover sessão inválida e mostrar erro; não criar bloqueio indefinido |
| Permissão privada ausente | Recusar início |
| Host protegido/interno | Recusar inclusão com erro curto |
| Aba fecha durante redirecionamento | Ignorar erro `tab not found` |
| Background reinicia | Reidratar do storage e reconciliar |

Logs permanecem locais no console e nunca contêm conteúdo de páginas. URLs completas só podem aparecer onde forem estritamente necessárias para restaurar a navegação bloqueada.

## 15. Interface e acessibilidade

Direção visual:

- tema automático claro/escuro;
- areia no tema claro, carvão suave no escuro;
- verde-sálvia como destaque;
- vermelho apenas para cancelamento e erros;
- tipografia de alta legibilidade e cronômetro com algarismos tabulares;
- movimento discreto e respeito a `prefers-reduced-motion`;
- navegação completa por teclado, foco visível e labels acessíveis;
- contraste mínimo WCAG AA.

O popup deve caber sem scroll no estado comum. Administração de listas ocorre somente na página completa de configurações.

O ícone possui duas variantes: neutra quando inativo e preenchida em verde-sálvia quando ativo. Não há badge na V1.

## 16. Estrutura proposta do projeto

```text
focus-extension/
├── entrypoints/
│   ├── background.ts
│   ├── popup/
│   │   ├── index.html
│   │   └── App.tsx
│   ├── options/
│   │   ├── index.html
│   │   └── App.tsx
│   └── blocked/
│       ├── index.html
│       └── App.tsx
├── src/
│   ├── domain/
│   │   ├── session.ts
│   │   ├── profiles.ts
│   │   ├── hosts.ts
│   │   └── backup.ts
│   ├── application/
│   │   ├── commands.ts
│   │   ├── messages.ts
│   │   └── reconcile.ts
│   ├── infrastructure/
│   │   ├── browser-storage.ts
│   │   ├── alarms.ts
│   │   ├── blocking.ts
│   │   └── notifications.ts
│   ├── ui/
│   │   ├── components/
│   │   ├── theme/
│   │   └── i18n/
│   └── schemas/
├── public/
│   ├── icons/
│   └── _locales/pt_BR/messages.json
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docs/plans/
├── wxt.config.ts
└── package.json
```

## 17. Testes

### 17.1 Unitários

- normalização de URL, IDNA, `www`, ponto final, IPv4, IPv6 e localhost;
- correspondência de domínio sem falsos prefixos;
- detecção e consolidação de redundâncias;
- unicidade e validação de nomes de perfil;
- duração e limites;
- derivação dos três estados temporais;
- limite exato de cancelamento;
- validação e migração de backup;
- rejeição de protocolos e hosts protegidos;
- segurança do destino `Voltar ao site`.

### 17.2 Integração com APIs simuladas

- início persiste antes de varrer abas;
- apenas uma sessão inicia sob comandos concorrentes;
- abas normais, privadas e fixadas são avaliadas;
- somente `main_frame` é redirecionado;
- iframe do YouTube permanece permitido;
- reinício do background recupera sessão e alarme;
- sessão expirada é reconciliada;
- cancelamento após 60 segundos é recusado pelo background;
- falha de notificação não preserva bloqueio;
- importação não grava parcialmente;
- perfil ativo permanece imutável.

### 17.3 Checklist manual obrigatório

Executar no Zen 1.21.15b e Firefox 154 instalados no macOS:

1. iniciar com 5 e 180 minutos;
2. validar confirmação de dois segundos;
3. cancelar antes de 60 segundos e rejeitar depois;
4. bloquear URL digitada, link, redirect e refresh;
5. bloquear abas abertas, fixadas e em segundo plano;
6. validar múltiplas janelas, containers e janela privada;
7. confirmar iframe permitido;
8. fechar/reabrir navegador durante sessão e durante a janela de cancelamento;
9. terminar automaticamente com popup fechado;
10. validar notificação e retorno manual das páginas bloqueadas;
11. exportar, alterar dados e restaurar por substituição;
12. revogar permissão privada e confirmar recusa de início;
13. testar temas claro/escuro, reduced motion e navegação por teclado.

## 18. Critérios de aceite da V1

A V1 está pronta quando:

1. todos os testes unitários e de integração passam;
2. o checklist manual passa no Zen e Firefox do macOS;
3. nenhuma navegação principal para hosts do snapshot ativo exibe o site antes do redirecionamento;
4. iframes e sub-recursos continuam permitidos;
5. uma sessão válida sobrevive ao reinício do navegador;
6. cancelamento é aceito somente dentro dos 60 segundos originais;
7. ao expirar, o bloqueio é removido mesmo se a notificação falhar;
8. importação inválida nunca altera o estado atual;
9. o pacote de desenvolvimento e o `.xpi` são gerados de forma reproduzível;
10. não existe chamada de rede, telemetria nem script remoto no código da extensão.

## 19. Empacotamento e distribuição

- Scripts de desenvolvimento devem iniciar Firefox e permitir apontar manualmente para Zen quando necessário.
- Build de produção gera ZIP para revisão e XPI.
- Para instalação persistente, o XPI precisa ser assinado pela Mozilla, inicialmente no canal não listado.
- A configuração de assinatura e credenciais não faz parte do bundle nem do repositório.
- Uma futura publicação exige revisão de política de privacidade, descrição das permissões e matriz adicional em Windows/Linux.

## 20. Evoluções futuras registradas

- perfis combináveis;
- histórico e estatísticas de sessões;
- ciclos de foco e descanso;
- sons configuráveis;
- badge e atalhos;
- onboarding;
- sincronização opcional;
- suporte oficial a Windows/Linux;
- nome e identidade definitivos.

## 21. Referências técnicas

- [Mozilla — `storage.local`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local)
- [Mozilla — permissões de WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)
- [Mozilla — background no Manifest V3](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Mozilla — `extension.isAllowedIncognitoAccess`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extension/isAllowedIncognitoAccess)
- [Mozilla — domínios e páginas restritas](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#restricted_domains)
- [Mozilla — interceptação de requisições](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Intercept_HTTP_requests)
- [WXT — documentação](https://wxt.dev/)
