# Reporte de bug pelo plugin GoLiveBypass

**Data:** 2026-09-13
**Escopo:** plugin Vencord/Equicord do GoLiveBypass (`goLiveBypass/`)
**Base:** `upstream/main` (0c6e6e5)
**Estado:** aprovado pelo usuário (opção 1 — reporte manual, espelhando a GUI, com endpoint e token embutidos no processo nativo e funcionando sem configuração); nenhum código alterado nesta rodada

## Contexto

A API de bug reports já está em produção e recebe relatos de dois clientes: a GUI
(`golive-gui/electron/bugreport.ts`, `POST /v1/reports`) e os instaladores de
terminal (`installer/golivebypass-installer.sh`, seção "Report de bugs"). O
plugin do Discord não reporta nada: quem usa o plugin e encontra um problema só
tem o comando `/golivebypass`, que copia um diagnóstico para o clipboard e para o
canal (`buildReport()`, `goLiveBypass/index.tsx:2024`). O usuário fica sem o
caminho mais curto para abrir a issue e os desenvolvedores ficam sem os logs da
sessão em que o defeito apareceu.

Este documento desenha o reporte de bug dentro do plugin **espelhando** os dois
clientes existentes e funcionando imediatamente depois da instalação: o plugin usa
o **mesmo endpoint e o mesmo token da GUI**, declarados como constantes no
processo nativo (o `native.ts` é empacotado no app desktop, enquanto o renderer é
o zip do userplugin). A URL e o token ficam **apenas** ali e nunca atravessam
para o renderer — não aparecem no modal, no payload, no log nem na resposta da
bridge. O token embutido é extraível do zip por quem o inspecionar e **não é um
segredo forte**; o escopo dele é abrir issue em repositório público, com rate
limit por IP. Esse trade-off foi escolhido pelo usuário (opção 1) e é o mesmo que
a GUI já adota (`golive-gui/electron/bugreport.ts:22-26`).

## Objetivo e invariantes

O usuário pode enviar, por ação explícita sua, um relato com **título**,
**descrição** e os **logs da sessão** do plugin para a API de bug reports, que
abre a issue no repositório de produção.

Os invariantes são:

- **Manual, nunca automático.** Nenhum hook de falha, boot, ativação, updater ou
  flux chama o reporte. Só o submit do modal (e nenhum outro caminho) chama
  `submitBugReport`; o comando `/golivebypass` continua apenas copiando texto.
- **Token e rota só no processo nativo.** O renderer não conhece o endereço da
  API nem o token; nenhum dos dois aparece em `index.tsx`, no modal, no payload,
  no log do plugin ou na resposta da bridge.
- **O token embutido não é segredo forte, e isso é aceito.** Ele é extraível do
  zip/asar do processo nativo; não protege contra leitura do pacote, apenas
  impede que a URL e o token circulem pelo renderer, pelos logs e pelos relatos.
  O freio real contra abuso é o rate limit por IP com bloqueio temporário na API.
- **Sanitização em três camadas antes de qualquer byte sair da máquina**, com
  bloqueio total do envio se um segredo conhecido sobreviver (L3).
- **O relato nunca carrega credenciais, rota de saída ou chave WireGuard.**
  Endpoint WireGuard, `PrivateKey`, caminhos de perfil, `AllowedApps`, usuário
  Proton e IPs de saída ficam de fora do payload e do log enviado.
- **Falha não perde o relato do usuário.** Todo caminho de erro mantém o texto
  digitado e oferece o diagnóstico para copiar.
- **Nada bloqueia o Discord.** O envio tem prazo próprio e roda no processo
  nativo; a UI nunca fica presa esperando a API.
- **Isolamento preservado.** Nenhuma mudança em `vpn-controller.ts`,
  `vpn-windows.ts`, `vpn-linux.ts`, `vpn-proton.ts`, `vpn-types.ts`,
  `stability.ts`, patches, flux, updater ou settings do plugin.

## Não-objetivos

- Relato automático de falha (telemetria). O instalador faz isso por decisão
  própria; o plugin não faz.
- Alterar a GUI, o standalone, os instaladores ou a API. A única lacuna
  conhecida fora do plugin é a label da issue (ver "Riscos e decisões
  operacionais"), que fica para uma rodada posterior.
- Enviar o diagnóstico para canal do Discord; o `sendBotMessage` do comando
  permanece como está.
- Mover o token ou o endpoint para o renderer, ou criar configuração externa
  (variáveis de ambiente, `settings.json`) para o reporte. O plugin usa as mesmas
  constantes embutidas da GUI e não lê nenhuma configuração de bug report.
- Trocar o backend: o endpoint, o token e o formato do payload são os mesmos da
  GUI, para os dois clientes caírem na mesma API.
- Reporte manual com anexo de arquivo, screenshot ou escolha de labels.
- Login, rota, túnel ou qualquer fluxo de rede novo.

## Arquitetura

Três peças, nenhuma delas nova infraestrutura de IPC:

```
renderer (index.tsx)            processo nativo (native.ts)                     API
  BugReportModal
    openBugReport()
      │ buildRendererDiagnostics()
      │
      ├─ Native.getBugReportStatus() ──► GET BUG_STATUS_URL ─────────────────► API
      │                                  prazo 5s; sem URL/token na resposta
      │   ◄──────────────────────────── { blocked, retryAfter, remaining }
      │
      └─ Native.submitBugReport({ title, description, includeLogs, session })
             │ valida e corta (renderer é não confiável)
             │ constantes BUG_API_URL/BUG_API_TOKEN (token só aqui)
             │ monta log (ring + cauda do arquivo) e meta
             │ redige L1 + L2, corta em 240 KiB, bloqueia no L3
             │ dedup por assinatura (48h)
             └─ POST BUG_API_URL ─────────────────────────────────────────► API
                    prazo 15s; grava estado só no 201
      ◄──────────────────────────── { ok, code, issueUrl, issueNumber, deduped,
                                      blocked, retryAfter, error }
```

A ponte é o mecanismo que o plugin já usa: `VencordNative.pluginHelpers.GoLiveBypass`
(`index.tsx:72`) expõe automaticamente cada `export` de `native.ts` ao renderer
(o build do Equicord monta esse mapa a partir de `src/userplugins/<plugin>/native.ts`,
mesma regra para `plugins/` e `equicordplugins/`). Não há canal IPC novo, nem
preload, nem `shell`.

### `goLiveBypass/bug-report.ts` (novo, módulo puro)

Sem Electron, sem `node:https`, sem estado global — importável por `node:test`
como `stability.ts` e `update-security.ts`. Contém toda a lógica que precisa de
teste comportamental:

- `redigir(texto, segredos, token)` — L1 + L2.
- `segredosRemanescentes(texto, segredos, token)` — varredura que decide o L3.
- `cortarCauda(texto, maxBytes)` — corte preservando o fim, sem partir linha.
- `montarLog({ ring, caudaArquivo, sessao, segredos, token })` — monta e redige o
  bloco de log.
- `montarMeta({ versao, estadoVpn, modo, onboarding })` — meta por campos
  tipados.
- `montarPayload({ titulo, descricao, log, meta })` — valida/corta e devolve
  `{ payload, bloqueado, code }`.
- `assinaturaDoRelato(titulo, descricao)`.
- `decidirEnvio(ultimoEnvio, assinatura, agora)` — `ultimoEnvio` é o estado
  persistido (ou `null`).
- `interpretarResposta(status, retryAfter, corpoTexto)` — HTTP → objeto devolvido
  ao renderer.

Única dependência: `node:crypto` para o hash da assinatura.

### `goLiveBypass/native.ts` (alterado, ~90 linhas)

Novos itens, ao lado dos exports existentes `getVpnStatus`/`getLog`/`getPluginVpnPaths`:

- constantes `BUG_API_URL` e `BUG_STATUS_URL` (mesmos valores da GUI:
  `golive-gui/electron/bugreport.ts:22-23`) e `BUG_API_TOKEN` (mesmo valor de
  `golive-gui/electron/bugreport.ts:26`), declaradas neste arquivo e nunca
  exportadas ao renderer;
- `coletarSegredosLocais()` — termos literais para o L2 (inclui o próprio
  `BUG_API_TOKEN`);
- `lerCaudaDoLog(maxBytes)` — cauda do `LOG_FILE`.
- `lerEstadoDeEnvio()` / `gravarEstadoDeEnvio(signature, issueUrl)`.
- `export function getBugReportStatus(_: IpcMainInvokeEvent)`.
- `export async function submitBugReport(_: IpcMainInvokeEvent, value: unknown)`.

Reutiliza o que já existe no arquivo: `history`/`LOG_FILE` (log),
`pluginSettings()` (usuário Proton, só como termo de varredura),
`controller.getStatus()` (estado para o meta), `controller.paths.serviceConfigPath`
(leitura da `PrivateKey`, só como termo de varredura) e o padrão de prazo de
`downloadBytes` (`native.ts:1017`).

### `goLiveBypass/index.tsx` (alterado, ~130 linhas)

- Refatoração cirúrgica de `buildReport()` (`index.tsx:2024`): extrai
  `buildRendererDiagnostics()` com as seções que só o renderer enxerga (video
  guard, `supports`, transmissão, região, configuração). `buildReport()` continua
  com o mesmo texto final (seções + processo principal + `Native.getLog()`) para
  não mudar o comando `/golivebypass`.
- `BugReportModal` + `openBugReport()`.
- Um `<Button>Reportar bug</Button>` na linha de ações do `VpnPanel`
  (`index.tsx:1482`).
- Uma entrada `"Reportar bug no GoLiveBypass": openBugReport` em
  `toolboxActions` (`index.tsx:2079`).

### O que não muda

`definePluginSettings` (`index.tsx:1383`) não ganha nenhuma opção: endpoint e
token não são configuração do plugin, e nenhuma variável de ambiente ou
`settings.json` é lida para o reporte. Nada é escrito em disco além do arquivo de
estado de deduplicação na pasta privada do plugin.

## Contrato renderer ↔ native

### Renderer → native (`submitBugReport`)

```json
{
  "title": "Go Live ainda bloqueado com a VPN ativa",
  "description": "O que aconteceu, o que esperava e os passos para reproduzir",
  "includeLogs": true,
  "session": "== o servidor te bloqueia? ==\n(atribuição, supports, região, configuração)"
}
```

- `title`, `description` e `session` são strings; `includeLogs` é booleano.
- `session` é `buildRendererDiagnostics()`, já sem título/descrição (que têm
  campos próprios) e sem chaves.
- O renderer é tratado como não confiável: o native valida e corta de novo,
  como `cleanLoginPayload`/`cleanRouteDiscoveryOptions` já fazem. Limites:

| Campo | Renderer (UI) | Native (autoritativo) |
|---|---|---|
| `title` | `maxLength` 200, obrigatório | `trim()`, não-vazio, `slice(0, 200)` |
| `description` | `maxLength` 8192 | `slice(0, 8192)` |
| `session` | gerado no renderer (texto de seções fixas, sem cap próprio) | `slice(0, 16384)` |
| `includeLogs` | switch ligado por padrão | `includeLogs !== false` |

### Native → renderer

Objeto de campos fixos, sempre:

```json
{
  "ok": true,
  "code": "OK",
  "issueUrl": "https://github.com/bezumiya/GoLiveBypass/issues/123",
  "issueNumber": 123,
  "deduped": false,
  "blocked": false,
  "retryAfter": 0,
  "error": ""
}
```

Nunca inclui: endereço da API, token, log, meta, corpo bruto do servidor,
caminho de arquivo ou estado interno. `error` é uma mensagem curta já
sanitizada por `safeDiagnosticDetail`.

### `getBugReportStatus`

Chamado ao abrir o modal. Devolve
`{ blocked: boolean, retryAfter: number, remaining: number }` — sem URL e sem
token; `remaining` é apenas informativo (os estados do modal não o exibem).
Consulta `GET BUG_STATUS_URL` com `Bearer` (rota autenticada e fora do rate limit:
`api/internal/server/server.go:50-51`), prazo de 5 s. Falha na consulta é tratada
como "não bloqueado"; o `POST` dá o veredito real.

### Endpoint e token

O reporte não tem configuração em runtime: `BUG_API_URL`, `BUG_STATUS_URL` e
`BUG_API_TOKEN` são constantes de `native.ts`, com os **mesmos valores** da GUI
(`golive-gui/electron/bugreport.ts:22-26`), então GUI e plugin caem na mesma API
com o mesmo escopo. Consequências declaradas:

- o token é extraível do zip/asar por quem inspecionar o pacote: **não é um
  segredo forte** e não é tratado como um;
- a defesa contra abuso é do servidor — rate limit por IP com bloqueio
  temporário (`RATE_LIMIT`, `BLOCK_SECONDS`);
- nenhuma variável de ambiente ou `settings.json` é lida para o reporte; trocar
  de backend significa mudar a constante (não existe caminho de configuração em
  runtime);
- nenhuma linha do log do plugin cita o token ou o header `Authorization`, e o
  L2/L3 tratam o próprio `BUG_API_TOKEN` como termo a não deixar escapar no
  relato.

## Payload

`POST BUG_API_URL` com `Authorization: Bearer BUG_API_TOKEN`,
`Content-Type: application/json`, `User-Agent: GoLiveBypass-plugin/1.0`.

```json
{
  "title": "string até 200 caracteres",
  "description": "string até 8192 caracteres",
  "log": "string até 240 KiB (ausente se includeLogs=false)",
  "meta": {
    "app": "golive-plugin",
    "versao": "2.0.0-beta.1",
    "plataforma": "linux-x64",
    "vpn_estado": "active",
    "vpn_ativa": "sim"
  }
}
```

O exemplo de `meta` mostra cinco das onze chaves; a lista completa está em "Meta".

`includeLogs` não vai no corpo (é decisão local); a API ignora campos
desconhecidos, mas o payload deve conter exatamente estas quatro chaves. O token
vai **somente** no header `Authorization`: o corpo nunca contém o token nem o
endpoint.

### Limites

| Limite | Valor | Onde |
|---|---|---|
| `title` | 200 caracteres | plugin, GUI e API (`api/internal/bugreport/report.go:10`) |
| `description` | 8 KiB | plugin, GUI e API (`report.go:11`) |
| `log` montado | 240 KiB (245 760 bytes) | plugin e GUI |
| `log` aceito pela API | 256 KiB (`MAX_LOG_BYTES=262144`) | `api/internal/config/config.go:36` |
| corpo HTTP | 512 KiB | `middleware.BodyLimit(512*1024)`, `server.go:43` |
| corpo da issue | 64 KiB, cabeça+cauda | `report.go:15,67-98` |
| taxa | 10 req/min por IP, bloqueio de 300 s | `RATE_LIMIT`, `BLOCK_SECONDS` |

O teto local de 240 KiB (e não 256 KiB) existe porque o JSON com escaping
cresce; é o mesmo valor da GUI (`LOG_TOTAL_MAX`).

### Meta

Somente chaves de uma lista branca, todas string:

| Chave | Origem |
|---|---|
| `app` | constante `golive-plugin` |
| `versao` | `currentPluginVersion()` (`native.ts:2113`), lida do manifest instalado |
| `plataforma` | `process.platform` + `-` + `process.arch` (ex.: `linux-x64`) |
| `electron` / `node` | `process.versions` |
| `vpn_estado` | `status.state` |
| `vpn_ativa` | `sim`/`nao` a partir de `status.active` |
| `vpn_propria` | `sim`/`nao` a partir de `status.owned` |
| `vpn_geracao` | `status.generation` |
| `vpn_modo` | `pluginSettings().vpnMode` |
| `onboarding` | `sim`/`nao` a partir de `onboardingCompleted` |

Nunca entram no meta: `profilePath`, `configPath`, `discordPid`,
`externalReason`, `message`, `lastDiagnostic` inteiro, `dataDir`, caminho do
log, endpoint WireGuard, nome de servidor/rota, IP de saída, usuário Proton,
`AllowedApps` ou qualquer caminho de arquivo do usuário. O meta é montado campo
a campo — `VpnStatus` carrega `profilePath` e `configPath`
(`vpn-controller.ts:466`), então espalhar o objeto de status vazaria caminhos.

### Log montado

Ordem fixa, com marcadores:

1. `=== sessao do plugin (renderer) ===` + `session`;
2. `=== plugin (memoria) ===` + ring buffer (400 linhas, `MAX_LOG_LINES`);
3. `=== plugin-vpn.log (antes do ring) ===` + complemento da cauda do arquivo.

O ring já contém as linhas recentes, então a cauda do arquivo contribui
**somente** com o que veio antes da primeira linha do ring: o recorte é feito na
primeira ocorrência dessa linha dentro da cauda. Se a primeira linha do ring não
for encontrada na cauda (arquivo rotacionado ou ring vazio de origem), a cauda é
**descartada** e o bloco fica só com as partes 1 e 2 — a política é "nunca
repetir a sessão", mesmo perdendo o trecho anterior à rotação. O caso com recorte
é o mesmo que a GUI adotou depois do bug de sessão duplicada
(`golive-gui/electron/bugreport.ts`, `montarLog`); o descarte é divergência
deliberada, porque no caminho equivalente a GUI anexa a cauda inteira e volta a
duplicar linhas. Depois da montagem, o bloco inteiro passa por `redigir` e por
`cortarCauda` (240 KiB, preservando o fim, sem partir linha).

## Sanitização em três camadas

Roda no processo nativo, antes do POST: L1 → L2 → `cortarCauda` → L3.

### L1 — padrões conhecidos (regex)

| Regra | Efeito |
|---|---|
| credenciais em URL (`scheme://usuario:senha@host`) | `scheme://usuario:***@host` |
| cabeçalho de autenticação (`authorization:` / `proxy-authorization:`) | valor → `***` |
| token do Discord (`mfa.*`, JWT-like de três segmentos) | `***` |
| query do gateway (`https://gateway...?params`) | `?<params>` |
| e-mail | `<email>` |
| `/home/<usuario>`, `/Users/<usuario>`, `C:\Users\<usuario>` | `.../<usuario>` |
| rótulo de identidade (`nome`/`usuário`/`username`: valor) | `<usuario>` |
| `PrivateKey = ...` | `<redacted>` |
| `Endpoint = host:porta` | `<redacted>` |

A regra de `PrivateKey` já existe em `safeDiagnosticDetail` (`vpn-types.ts:229`).
A de `Endpoint` é **nova** deste desenho: o endpoint WireGuard é a saída
escolhida da pessoa, e a GUI já decidiu não expô-la (`montarMeta` em
`golive-gui/electron/bugreport.ts`). As demais são cópia deliberada de
`golive-gui/electron/redact.ts` (o zip do plugin não importa código da GUI).

### L2 — segredos conhecidos (ocorrência literal)

Termos conhecidos que não podem sair no relato, removidos por substituição
literal para pegar vazamento fora de padrão:

- diretório home do usuário;
- usuário Proton salvo nas configurações do plugin;
- `PrivateKey` extraída de `controller.paths.serviceConfigPath`: o arquivo é lido
  **apenas** para obter o valor da chave como termo de varredura, e nenhuma
  linha dele entra no payload;
- `customConfigPath` quando preenchido;
- o próprio `BUG_API_TOKEN`.

Mesmo princípio de `coletarSegredos` na GUI: os dados servem à varredura local e
nunca entram no payload.

### L3 — bloqueio

Sobre `JSON.stringify` do corpo final: se algum termo conhecido sobreviveu, nada
sai da máquina. O native devolve `{ ok: false, code: "SEGREDO_REMANESCENTE" }`,
registra no log local `envio de relato bloqueado: segredo remanescente` **sem
imprimir o segredo**, e o renderer mostra "Não enviei o relato por segurança.
Copie o diagnóstico e revise antes de enviar."

Observação: o log do plugin já nasce reduzido — `log()` aplica
`safeDiagnosticDetail` em mensagem e em cada valor de `data`
(`native.ts:337-352`) — e a fronteira de progresso Proton descarta endpoint,
configuração, chave e sessão por contrato (`vpn-controller.ts`). A redação do
relato é a segunda barreira, não a única.

## Deduplicação

- **Assinatura:** `sha256(title.trim() + "\n" + description.trim())`, primeiros
  16 caracteres. O log **não** entra na assinatura (muda a cada segundo e
  anularia o dedup); a diferença entre dois relatos está no que o usuário
  escreveu.
- **Janela:** 48 h (172 800 s), igual à do instalador
  (`installer/golivebypass-installer.sh:196-217`).
- **Estado:** `<VPN_DATA_DIR>/bug-report-state.json` =
  `{ "signature": "9f2c1a7b3d4e5f60", "issueUrl": "https://github.com/bezumiya/GoLiveBypass/issues/123", "at": 1757786400 }`
  (`at` em epoch de segundos) — uma entrada, na pasta privada que o plugin já
  cria para o log.
- **Fluxo:** `decidirEnvio` roda depois de o L3 passar (o endpoint é constante,
  não há o que configurar). Mesma assinatura dentro da janela → **não** posta e
  devolve `{ ok: true, deduped: true, issueUrl }` do relato anterior; assinatura
  diferente ou janela vencida → posta.
- **Gravação só no sucesso:** o estado é escrito **somente** após um `201` com
  `issue_url`. O instalador grava antes de enviar; ali uma falha de rede faz o
  mesmo erro sumir por 48 h. O plugin não repete esse defeito.
- **Anti duplo clique:** além do dedup persistente, o modal tem estado `sending`
  que desabilita o botão, como o `busy` já usado no painel.

## UX

### Ponto de entrada

- Botão **"Reportar bug"** na linha de ações do `VpnPanel` (junto de "Ativar
  agora", "Restaurar rede" e "Testar .conf"). O `VpnPanel` é renderizado dentro
  do `AboutPlugin`, que é o `settingsAboutComponent` — o botão aparece no painel
  e em Configurações → Plugins → GoLiveBypass, sem tela nova.
- Entrada em `toolboxActions`: "Reportar bug no GoLiveBypass".
- O botão fica sempre habilitado, inclusive durante ativação/otimização: ele não
  muda rede nem túnel, e o momento de maior valor diagnóstico é justamente o de
  falha.

### Modal

`BugReportModal` sobre `openModal`/`closeDiscordModal`, como
`PluginOnboardingModal` (`index.tsx:527`):

- `TextInput` (`@webpack/common`, já importado) para o resumo (`maxLength` 200,
  obrigatório);
- `TextArea` (`@webpack/common`, mesmo módulo de `TextInput`/`Modal`) para os
  detalhes (`maxLength` 8192);
- switch **"Incluir logs da sessão (recomendado)"** (`FormSwitch` de
  `@components`, importado por arquivo como `Card`/`Paragraph`), ligado por
  padrão;
- o texto do resumo vai como `title` e os detalhes como `description`; a seção
  técnica vai em `session`, nunca dentro da descrição.

Estados:

| Estado | UI |
|---|---|
| `idle` | formulário; "Enviar" desabilitado enquanto o título estiver vazio |
| `sending` | botão desabilitado, rótulo "Enviando…" |
| `success` | título e detalhes zerados; link da issue (`MaskedLink`) + "Copiar diagnóstico" |
| `deduped` | "Esse mesmo relato já foi enviado há pouco." + link da issue existente; campos zerados |
| `blocked` | "Você está bloqueado por enviar reports em excesso. Tente novamente em Xmin/Ys.", com contagem regressiva e "Enviar" desabilitado até expirar; campos preservados |
| `error` | mensagem do erro + "Copiar diagnóstico"; campos **preservados** |

Regras de produto: campos são zerados **apenas no sucesso** (inclusive no
deduped); a contagem regressiva vem sempre do servidor (`Retry-After` ou
`retry_after`), nunca de um valor fixo do cliente; o diagnóstico nunca é enviado
a um canal do Discord. Não existe estado de "envio não configurado": com o token
embutido o envio está sempre disponível, e a única falha possível é a da própria
chamada.

Ajuda em falha: `copyWithToast(await buildReport(), "Diagnóstico copiado.")` no
botão "Copiar diagnóstico". O caminho de cópia é local (usa o `buildReport()` que
já existe) e não abre navegador nem carrega o log em URL.

Acessibilidade, no padrão já auditado do projeto (`tests/test-plugin-ui-audit.mjs`):
`role="alert" aria-live="assertive"` nos erros, `role="status"` no progresso,
`aria-label` nos campos, `Modal` com `title`, foco no cabeçalho ao abrir.

Ciclo de vida: `openBugReport()` tem guarda de instância única e token de
geração (mesmo desenho de `onboardingOpen`/`onboardingModalKey`), e `stop()`
fecha o modal e invalida respostas tardias.

## Estados de erro e bloqueio

| Resposta | `code` | UI |
|---|---|---|
| `201` | `OK` | sucesso + link da issue |
| `400` | `INVALIDO` | mensagem do servidor sanitizada (ex.: "title e obrigatorio") |
| `401` | `NAO_AUTORIZADO` | "A API recusou o envio. Atualize o plugin." |
| `413` | `LOG_GRANDE` | "O relato ficou grande demais para enviar." + diagnóstico para copiar |
| `429` | `BLOQUEADO` | aviso com `retry_after` e contagem regressiva; campos preservados |
| `502` | `GITHUB` | "O GitHub recusou a criação da issue. Tente mais tarde." |
| outros `5xx` | `API_INDISPONIVEL` | erro + diagnóstico para copiar |
| sem conexão / prazo de 15 s | `REDE` | erro + diagnóstico para copiar |
| título vazio (local) | `TITULO_OBRIGATORIO` | validação no formulário |
| L3 disparado (local) | `SEGREDO_REMANESCENTE` | "Não enviei o relato por segurança." |

O `POST` usa prazo de 15 s no mesmo padrão de deadline de `downloadBytes`
(`native.ts:1017`: timer + destruição da requisição) e lê no máximo 16 KiB do
corpo da resposta. Erros nunca incluem o endpoint nem o token, e o log local
registra apenas o status e um motivo curto — nunca o header `Authorization`.

Cada `code` de erro usa o estado `error` do modal, com a mensagem indicada na
tabela; a única exceção é `BLOQUEADO` (estado `blocked`). `OK` e o dedup usam os
estados `success` e `deduped`.

## Testes

Convenção do repositório: os testes do plugin ficam em `tests/test-plugin-*.mjs`
e rodam direto com `node <arquivo>` (o Node 26 importa `.ts` do próprio
repositório, como faz `tests/test-plugin-build-command.mjs`). Este desenho
adiciona `tests/test-plugin-bug-report.mjs` e `tests/test-redaction-parity.mjs`.

### `tests/test-plugin-bug-report.mjs` (novo, importa `goLiveBypass/bug-report.ts`)

1. **L1:** `socks5://ana:NAOVAZA123@10.0.0.1` sai como
   `socks5://ana:***@10.0.0.1` e `NAOVAZA123` não aparece em nenhum ponto do
   payload; idem cabeçalho de autorização, `mfa.*`, query do gateway, e-mail e
   `/home/<usuario>`.
2. **L1 (regra nova):** `Endpoint = 203.0.113.7:51820` vira `<redacted>` e o IP
   não aparece no JSON final.
3. **L2:** termo conhecido em formato que o L1 não cobre (marca
   `ZQX9-SEGREDO-LITERAL`) é removido de título, descrição, sessão e log.
4. **L3:** termo conhecido que sobrevive → `montarPayload` devolve
   `{ bloqueado: true, code: "SEGREDO_REMANESCENTE" }` e o objeto devolvido não
   contém o segredo.
5. **Corte:** log de 400 KiB → ≤ 240 KiB, contém a última linha do original, o
   trecho não começa no meio de uma linha e há marcador de truncamento.
6. **Dedup de log:** ring `[A,B,C]` + cauda `X\nA\nB\nC` → o complemento é só
   `X`, e `B` aparece uma única vez; quando a primeira linha do ring não está na
   cauda, a cauda é descartada e nenhuma linha do arquivo entra no bloco.
7. **Assinatura:** mesma dupla título+descrição → mesmo hash; descrição
   diferente → hash diferente.
8. **Decisão de envio:** mesma assinatura com menos de 48 h →
   `{ enviar: false, issueUrl }` do relato anterior; mais de 48 h → enviar; sem
   estado → enviar.
9. **Meta:** chaves exatamente as da lista branca e o JSON do meta não contém
   home, nome de arquivo `.conf`, nome de servidor/rota nem token.
10. **Resposta:** `201` com `issue_url`/`html_url` → `OK`; `401` →
    `NAO_AUTORIZADO`; `400` → `INVALIDO` com a mensagem do servidor; `413` →
    `LOG_GRANDE`; `429` com `Retry-After: 300` → `blocked` com `retryAfter=300`;
    `502` → `GITHUB`; erro de socket/prazo → `REDE`. Nenhum dos objetos
    devolvidos tem as chaves `token`, `authorization`, `endpoint` ou `log`.
11. **Token não vaza no relato:** com o token marcador
    `NAOVAZA-TOKEN-MARCADOR` passado como termo conhecido e presente no log de
    entrada, o `JSON.stringify` do payload montado não contém esse token (o L2/L3
    cobre o próprio `BUG_API_TOKEN`).

### Fronteira do renderer (sem teste automatizado)

`index.tsx` não é carregável por Node (depende do runtime do Discord), então a
fronteira do renderer — sem host, sem token e sem `Bearer` no arquivo, e um único
ponto de chamada do envio — **não tem teste automatizado**. Esses invariantes
seguem valendo como contrato de implementação: o renderer só chama
`Native.submitBugReport`/`Native.getBugReportStatus`, não importa valor de
`./bug-report` (apenas tipos, que o build apaga) e o envio só existe no submit do
modal. Um teste estático que lesse a fonte para prender nomes e contagens foi
considerado e descartado: prenderia a implementação em vez do contrato e não
sobreviveria a uma reorganização do arquivo.

### `tests/test-redaction-parity.mjs` (novo)

Compara as listas de padrões de `goLiveBypass/bug-report.ts` e
`golive-gui/electron/redact.ts` para impedir divergência entre os dois clientes.

### Verificação manual

Numa cópia de teste, apontar `BUG_API_URL`/`BUG_STATUS_URL`/`BUG_API_TOKEN` para
um servidor HTTP local em loopback: abrir o modal, enviar, conferir a issue fake,
confirmar que o token e o endpoint não aparecem no log do plugin nem no retorno
da bridge, e exercitar `401` (token recusado), `429` (contagem regressiva) e
queda de rede (a mensagem preserva o texto digitado). A suíte GUI (`npm test` em
`golive-gui/`) e a API (`go test ./...` em `api/`) não são afetadas por este
desenho.

## Riscos e decisões operacionais

- **A parte nativa exige atualização do zip do plugin.** `native.ts` é
  empacotado no app desktop pelo build do Equicord; o renderer sozinho não
  entrega o recurso. Vale o caminho normal de atualização do plugin.
- **O token embutido não é segredo forte — trade-off aceito.** Ele é extraível do
  zip/asar, e é o mesmo valor já embutido na GUI e nos instaladores. Consequência
  operacional: trocar o token exige publicar novas versões dos três clientes;
  enquanto isso, o rate limit por IP com bloqueio temporário é o freio contra
  abuso.
- **Label da issue.** A API aplica `ISSUE_LABELS` (padrão `bug,gui`) a todo
  relato e não há campo de labels no corpo: os relatos do plugin nasceriam com a
  label `gui`. Corrigir exige mudança pequena na API (mapa app → labels) ou
  ajuste de `ISSUE_LABELS`; fica fora desta rodada e está registrado aqui para
  não virar surpresa.
- **Duplicação deliberada da redação.** O plugin não importa
  `golive-gui/electron/redact.ts`; as regras L1 são copiadas e o teste de
  paridade é a defesa contra drift.
- **Sem testes de rede externa.** O POST e a consulta de bloqueio são exercidos
  por injeção de resposta e por servidor local; nenhum teste fala com a API de
  produção.

## Critério de conclusão

A rodada termina quando, com o recurso implementado: `tests/test-plugin-bug-report.mjs`
e `tests/test-redaction-parity.mjs` passam; a suíte `tests/test-plugin-*.mjs`
continua passando; o plugin usa o mesmo endpoint e token da GUI (constantes
conferidas na revisão, sem teste automatizado); um relato real pelo modal abre
issue com log redigido; um segundo envio idêntico em menos de 48 h não cria issue;
e um `429` mostra a contagem regressiva vinda do servidor, sem vazar endpoint ou
token no renderer, no log ou no payload.
