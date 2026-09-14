# Migração segura de sessão Proton no Windows

## Contexto

Uma sessão criada pela GUI beta-6 permanece em `%LOCALAPPDATA%\GoLiveBypass\proton-session.json` como JSON legado. A partir da beta-7, o helper Windows passa a proteger a sessão com DPAPI e migra uma sessão legado quando ela é lida. Nos relatos #288 e #290, a leitura chega ao commit atômico e `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)` retorna acesso negado. A tentativa de login então termina antes de consultar ou validar a senha.

## Objetivos

- Preservar a migração de sessão legada para DPAPI no Windows.
- Manter a troca do arquivo atômica e preservar o cache anterior em qualquer falha.
- Tolerar atributo readonly e bloqueios transitórios de arquivo sem aceitar sessão em texto claro.
- Expor falha de persistência como tal, sem atribuí-la a credenciais inválidas.
- Ler a identidade salva pelo contrato do helper, inclusive após o cache passar a ser DPAPI.
- Cobrir migração e concorrência com dados sintéticos, sem acessar Proton nem usar credenciais reais.

## Fora do escopo

- Alterar o formato da sessão em Linux.
- Mudar o caminho canônico do cache ou copiar uma sessão para outro arquivo.
- Reintroduzir delete-then-rename, fallback plaintext ou migração silenciosamente ignorada.
- Alterar WireSock, seleção de rota, instalador (coberto separadamente em `2026-09-14-installer-injection-design.md`), release, changelog ou autenticação Proton remota.

## Arquitetura

### Commit Windows

A migração continua sob o lock cross-process `proton-session.json.lock`. O helper valida que o destino é arquivo regular, grava o payload DPAPI em um temporário no mesmo diretório, fecha o temporário e tenta substituir o destino atomicamente.

Antes da primeira tentativa, o caminho Windows remove somente `FILE_ATTRIBUTE_READONLY` de um destino existente e validado. Nenhum outro atributo, ACL ou conteúdo é alterado. O commit tenta novamente por uma janela curta e fixa somente quando `MoveFileEx` retorna `ERROR_ACCESS_DENIED` ou `ERROR_SHARING_VIOLATION`. Cada tentativa continua usando replace atômico; não há remoção prévia do destino. Ao esgotar a janela, o temporário é removido e o cache anterior permanece intacto.

A falha final é representada por um erro de persistência seguro. O texto não inclui segredo nem conteúdo de sessão; os logs podem registrar somente a categoria e o código Win32.

### Contrato GUI

`classifyProtonError` reconhece falhas estruturadas ou textuais de migração/commit de sessão como `SESSION_PERSISTENCE`. A mensagem informa que a senha não foi verificada e que a sessão existente foi preservada, orientando tentativa após fechar versões antigas ou processos que possam reter o arquivo. Ela nunca usa a mensagem de senha incorreta.

A GUI deixa de interpretar diretamente `proton-session.json` para recuperar a identidade. Ela solicita apenas o username pelo helper com `-session-username -json`; o helper já adquire o lock e decifra/migra o arquivo antes de analisar a identidade. Erros ou ausência de sessão permanecem um fallback vazio, sem alterar a conta salva.

### Concorrência

O lock do helper permanece a autoridade para `Load`, `Save`, `Delete` e migração entre processos. Não será criada uma fila global na GUI: plano, catálogo e geração podem durar muito e não resolvem ACL ou um handle externo. O leitor de identidade deixa de ser um acesso Node fora do lock. O logout direto do Node continua fora desta alteração mínima e será tratado separadamente caso seu risco seja priorizado.

## Falhas e preservação

- Arquivo legado válido e substituível: migra para DPAPI e mantém a mesma identidade.
- Readonly: remove somente readonly, migra atomicamente.
- Handle transitório: retry limitado; depois da liberação, migra atomicamente.
- ACL ou handle persistente: retorna `SESSION_PERSISTENCE`; não envia senha, não apaga cache e não muda a conta.
- Cache DPAPI: identidade é obtida pelo helper, não por `JSON.parse` no Electron.
- Arquivo inválido, symlink, diretório ou tamanho excessivo: permanecem rejeitados pelas validações existentes.

## Testes e verificação

### Helper Go no Windows

Um teste cria um `SavedSession` legado com tokens sintéticos e validade futura. Ele:

1. marca o destino como readonly e confirma que `Load` migra para o cabeçalho DPAPI;
2. mantém o destino aberto sem share-delete durante uma janela curta e confirma que o retry termina depois da liberação;
3. inicia múltiplos `SessionStore` concorrentes contra o mesmo cache legado e confirma que todos leem a sessão sintética, que apenas o formato DPAPI permanece e que não sobram temporários.

Nenhum desses testes chama HTTP ou Proton.

### GUI

Testes do wrapper simulam a resposta JSON real de falha de migração e exigem `SESSION_PERSISTENCE`, mensagem sem culpa de senha e estado retryable coerente. Um teste do contrato `-session-username` confirma que a recuperação não depende de parse JSON local.

### Comandos

No Windows:

```sh
cd tools/proton-confgen
go test -race ./internal/auth -run 'TestWindowsLegacySessionMigration|TestWindowsSessionReplace' -count=100

cd ../../golive-gui
npm test -- tests/proton-login-errors.test.ts
npm test -- tests/proton.test.ts
```

## Critérios de aceite

- O helper fecha o arquivo legado antes de qualquer tentativa de migração.
- O commit continua atômico; uma falha nunca remove a sessão anterior nem aceita plaintext.
- Readonly e bloqueios transitórios recebem apenas o tratamento limitado descrito; falhas persistentes são estruturadas como persistência.
- A GUI nunca culpa senha por essa falha e preserva a sessão anterior.
- Recuperação de identidade funciona para sessão DPAPI pelo contrato seguro do helper.
- Migração Windows e estresse concorrente usam somente credenciais sintéticas.
