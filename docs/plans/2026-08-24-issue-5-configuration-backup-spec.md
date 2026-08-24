# Issue #5 — Backup e restauração da configuração local

- **Issue:** [#5 — Export and replace local configuration from backup](https://github.com/GuilhermeLuan/focus-extension/issues/5)
- **Status:** refinada e pronta para implementação
- **Base obrigatória:** #2 e #3, já integradas
- **Método:** TDD nas fronteiras puras e no serviço; o background continua sendo a autoridade de escrita

## 1. Resultado esperado

A página de opções permite exportar toda a `StoredConfiguration` para um arquivo JSON versionado e restaurar um arquivo compatível por substituição completa. `activeSession` nunca entra no arquivo. Exportar continua permitido durante uma sessão; importar fica indisponível sempre que existir uma sessão ativa.

A restauração tem quatro etapas visíveis: selecionar e validar o arquivo, visualizar um resumo, confirmar a substituição e baixar um backup preventivo da configuração corrente. Somente depois do download preventivo a página envia o comando final ao background. O background revalida o conteúdo, a ausência de sessão e a configuração corrente esperada, e persiste a nova configuração em uma única chamada a storage.

## 2. Formato V1 e serialização determinística

```ts
type FocusLockBackupV1 = {
  kind: "focus-lock-backup";
  schemaVersion: 1;
  exportedAt: string;
  configuration: StoredConfiguration;
};
```

O gerador constrói explicitamente as propriedades na ordem acima e as propriedades aninhadas na ordem declarada pelos tipos atuais. Mantém a ordem semântica dos arrays `profiles` e `domains`; não os reordena. Serializa com `JSON.stringify(value, null, 2) + "\n"`. Portanto, a mesma configuração e o mesmo relógio produzem exatamente os mesmos bytes UTF-8. `exportedAt` é `new Date(now).toISOString()`.

O nome da exportação é `focus-lock-backup-YYYY-MM-DD.json`, usando a data UTC de `exportedAt`. O nome preventivo é `focus-lock-pre-import-YYYY-MM-DDTHH-mm-ss-sssZ.json`, derivado do instante UTC e sem `:`. Ambos são gerados pela página com `Blob([content], { type: "application/json;charset=utf-8" })`, `URL.createObjectURL` e um link temporário com `download`; não se adiciona a permissão `downloads`.

## 3. Validação V1

O limite é inclusivo: até `1_048_576` bytes UTF-8 é aceito; qualquer byte adicional é recusado. A página testa `File.size` antes de ler e decodifica `ArrayBuffer` com `new TextDecoder("utf-8", { fatal: true })`. O background mede novamente `new TextEncoder().encode(content).byteLength` antes de `JSON.parse`.

O parser é estrito e não migra versões. Deve recusar:

- JSON inválido, raiz não objeto, propriedades ausentes ou desconhecidas;
- `kind` diferente de `focus-lock-backup` ou `schemaVersion` diferente de `1`;
- `exportedAt` que não seja uma forma ISO canônica (`new Date(value).toISOString() === value`);
- configuração ou estruturas aninhadas com propriedades ausentes/desconhecidas;
- duração fora de `5..180`, não inteira ou não múltipla de 5;
- lista vazia de perfis; IDs vazios/duplicados; nomes não aparados, com 0 ou mais de 40 caracteres, ou duplicados após NFKC + lowercase;
- `lastSelectedProfileId` que não referencia exatamente um perfil;
- timestamps que não sejam inteiros finitos não negativos ou tenham `updatedAt < createdAt`;
- hosts vazios/duplicados no mesmo perfil ou cujos `canonicalHost`, `displayHost` e `kind` não correspondam ao resultado canônico de `normalizeBlockedHost(canonicalHost)`.

Não há coerção, preenchimento de defaults nem migração silenciosa. O parser retorna uma cópia profunda nova. A V1 aceita somente o envelope acima; `activeSession` em qualquer posição é campo desconhecido e torna o arquivo inválido.

## 4. Contratos e autoridade do background

Adicionar os comandos e respostas discriminados:

```ts
type ExportConfigurationRequest = { type: "EXPORT_CONFIGURATION" };
type ExportConfigurationData = { fileName: string; content: string };

type ImportConfigurationRequest = {
  type: "IMPORT_CONFIGURATION";
  content: string;
  expectedCurrentConfiguration: StoredConfiguration;
};

type ImportConfigurationError =
  | "IMPORT_SESSION_ACTIVE"
  | "BACKUP_TOO_LARGE"
  | "INVALID_BACKUP"
  | "UNSUPPORTED_BACKUP_VERSION"
  | "CONFIGURATION_CHANGED"
  | "STORAGE_ERROR";
```

`EXPORT_CONFIGURATION` participa da fila do serviço, lê o estado reconciliado, gera o envelope a partir de `configuration` e devolve somente nome e conteúdo. Não devolve nem serializa `activeSession`.

`IMPORT_CONFIGURATION` também participa da fila. Dentro de uma única execução serializada ele:

1. mede o conteúdo e faz parse/validação completa;
2. lê o estado corrente;
3. recusa com `IMPORT_SESSION_ACTIVE` se houver sessão;
4. compara profundamente a configuração corrente com `expectedCurrentConfiguration` e recusa com `CONFIGURATION_CHANGED` se divergir;
5. chama `saveConfiguration(imported)` exatamente uma vez;
6. devolve o estado com a configuração importada e sem sessão.

Versão diferente de `1`, quando o envelope permite identificá-la, vira `UNSUPPORTED_BACKUP_VERSION`; tamanho excessivo vira `BACKUP_TOO_LARGE`; demais falhas de conteúdo viram `INVALID_BACKUP`. Exceções de storage viram `STORAGE_ERROR`. Nenhuma recusa chama `set` ou `remove`.

## 5. Fluxo da página de opções

Adicionar um card `Backup e restauração` depois das regras:

- botão `Exportar configuração`, habilitado mesmo com sessão, pede `EXPORT_CONFIGURATION` e baixa a resposta;
- input de arquivo `.json` e botão/label `Selecionar backup`;
- importação desabilitada, com nota curta, quando `state.activeSession` existir;
- após seleção válida, mostrar `exportedAt`, quantidade de perfis, total de regras, nome do perfil selecionado e duração padrão;
- arquivo inválido mostra erro curto e não mantém confirmação anterior;
- botão `Substituir configuração` abre `window.confirm` informando que todos os perfis e preferências locais serão substituídos;
- se confirmado, a página pede `GET_STATE`; se surgiu sessão, interrompe;
- gera e inicia o download preventivo a partir da configuração retornada; se criar/acionar o download lançar erro, interrompe sem enviar importação;
- envia exatamente um `IMPORT_CONFIGURATION`, usando o conteúdo validado e a configuração do `GET_STATE` como `expectedCurrentConfiguration`;
- sucesso atualiza a tela com o estado retornado e limpa arquivo, resumo e erros; cancelamento preserva a seleção para nova tentativa;
- `CONFIGURATION_CHANGED` ou `IMPORT_SESSION_ACTIVE` atualiza o estado com `GET_STATE`, não grava e pede ao usuário que tente novamente.

Enquanto exportação/importação aguarda resposta, o respectivo botão fica desabilitado para impedir comandos duplicados. Nenhuma UI escreve diretamente em `browser.storage.local`.

## 6. Plano TDD

Executar RED→GREEN e rodar o arquivo afetado mais `npm run typecheck` regularmente:

1. módulo puro `backup`: serialização/nome determinísticos e ausência de sessão;
2. parser: round-trip e rejeições de tamanho, UTF-8 na fronteira de arquivo, envelope, versão e invariantes aninhadas;
3. resumo: contagens, perfil selecionado, duração e data;
4. serviço: exportação durante sessão e importação recusada durante sessão;
5. serviço: importação válida faz uma escrita; conteúdo inválido, configuração concorrente e falha preservam a configuração;
6. helper de download: Blob/link local, nome correto e revogação da URL; sem testar bytes do browser nem CSS;
7. ligação da página: resumo antes da confirmação, backup preventivo antes do comando final e estados desabilitados.

## 7. Critérios de aceite verificáveis

- [ ] Exportação produz o envelope V1 em JSON UTF-8 indentado, com newline final, ordem determinística, data/nome UTC e sem `activeSession`.
- [ ] Exportação funciona durante sessão e usa Blob local sem permissão `downloads`.
- [ ] Arquivo com mais de 1 MiB, UTF-8 inválido, JSON inválido, versão não suportada ou qualquer invariante inválida é recusado sem escrita.
- [ ] Importação fica indisponível na UI e é recusada pelo background durante sessão ativa.
- [ ] Antes da confirmação aparecem data, perfis, regras, perfil selecionado e duração do backup.
- [ ] Cancelar a confirmação não baixa backup preventivo, não envia importação e não altera a configuração.
- [ ] Após confirmação, o backup preventivo da configuração corrente é iniciado antes do único comando de importação.
- [ ] Mudança concorrente da configuração entre o backup preventivo e o comando final produz `CONFIGURATION_CHANGED` e nenhuma escrita.
- [ ] Importação válida substitui toda a chave `configuration` em exatamente uma escrita e retorna o novo estado.
- [ ] Falha em leitura, validação, backup preventivo, concorrência ou storage preserva a configuração corrente; não existe escrita parcial.
- [ ] Testes cobrem round-trip, determinismo, ausência de sessão, limites de validação e ausência de escrita parcial.
- [ ] `npm test`, `npm run typecheck` e `npm run build` passam.

## 8. Fora de escopo

- incluir, interromper ou restaurar sessão ativa;
- migrar backups de versão desconhecida;
- mesclar perfis ou escolher itens individuais;
- criptografia, compactação, sincronização em nuvem ou histórico de backups;
- permissão `downloads`, diretório de destino customizado ou confirmação de conclusão pelo gerenciador de downloads;
- alterar o schema persistido `StoredConfiguration`.

## 9. Entrega e revisão

- Preservar alterações preexistentes não relacionadas, inclusive `docs/.DS_Store`.
- Não fechar a issue nem fazer push sem pedido explícito.
- Revisar o diff final, como Sol, item a item contra a seção 7.
- Relatar testes focados, suíte completa, typecheck e build.
