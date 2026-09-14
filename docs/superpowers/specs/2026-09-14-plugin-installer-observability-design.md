# Observabilidade local do plugin e dos instaladores

**Data:** 2026-09-14
**Base:** `upstream/main` em `8d69ad83a8c20ffc468a484674d9e7b5eb1a2e5c`
**Escopo aprovado:** observabilidade local/manual do plugin Vencord/Equicord e dos instaladores Windows/Linux; nenhuma telemetria remota.
**Decisão:** manter a recomendação dual-view: JSONL estruturado como representação local canônica e interfaces textuais atuais como view compatível.

## 1. Problema e evidência

Os logs do plugin são difíceis de correlacionar. `goLiveBypass/native.ts` grava linhas livres no formato `HH:MM:SS [level] message | key=value`, mantém 400 linhas em memória e limita `plugin-vpn.log` a 256 KiB. O controller compartilha esse logger entre ativação, restauração, WireSock, Linux, Proton e watchdog, mas as mensagens não têm um vocabulário nem um identificador operacional comum.

O helper Proton recebe um callback de log, porém `runConfgen` não registra início, término, duração, exit code ou resumo de stdout/stderr. Assim, falhas do helper chegam como mensagem genérica mesmo quando o processo forneceu uma causa classificável. O watchdog e as probes também podem repetir observações sem deduplicação. O ring começa vazio em cada processo: `getLog()` retorna somente a memória da execução corrente e não lê a cauda persistida após reload/relaunch.

O relatório `/golivebypass` continua sendo uma ação manual do usuário. `buildReport()` reúne diagnóstico do renderer, status nativo e `Native.getLog()`, copia o texto e envia até 1.800 caracteres ao canal pelo comando explícito. Esse consumidor não pode ser quebrado nem transformado em envio automático.

### Issue de produção #293

A #293 é uma falha do **instalador PowerShell**, não do transporte WireGuard do plugin. No fluxo histórico em `installer/GoLiveBypass-Installer.ps1`, `Find-Checkout` procura primeiro a origem indicada pela injeção (`require(...)` em `app.asar`/`app\index.js`) e depois somente raízes e profundidade de disco conhecidas. O resultado só é aceito quando prova a estrutura de checkout (`package.json` e `src\utils\types.ts`).

Quando `Get-InjectionIdentities` detecta Vencord/Equicord instalado, mas o checkout não pode ser provado, `Select-Target` lança:

> Detectei Vencord no Discord, mas nao encontrei o checkout fonte. Nenhum mod foi substituido; use -Source apontando para o checkout correto.

**Causa confirmada:** o gate de preservação bloqueia deliberadamente a instalação sem checkout verificável, antes de alterar `app.asar` ou `_app.asar`. O teste histórico `tests/test-vencord-preserve.sh` prova essa invariável.
**Hipótese não resolvida:** o relato não informa se o checkout estava ausente/empacotado, fora das raízes pesquisadas, inacessível, ou se o parser da injeção não reconheceu o caminho. A issue não contém evidência para escolher entre essas causas. O plugin WireGuard, Proton, WireSock e updater não são executados nesse caminho.

O contrato de observabilidade deve permitir distinguir essas etapas em versões futuras do instalador, sem registrar caminhos pessoais completos.

## 2. Objetivos, escopo e invariáveis

### Objetivos

- Registrar eventos estruturados, limitados e correlacionáveis para ativação, desativação/restauração, seleção de rota, Proton/login, helper, WireSock/Linux, updater, instaladores e erros.
- Permitir reconstruir uma operação localmente: ação, fase, tentativa, resultado, duração, causa classificada e estado final.
- Conservar o arquivo e as interfaces manuais existentes, com texto legível para suporte e consumidores atuais.
- Impedir que senha, token, chave, endpoint privado, sessão ou caminho pessoal atravessem o logger, o relatório ou o canal manual.
- Fazer diagnóstico ser best-effort: falha de log nunca impede o Discord, o túnel ou a restauração.

### Escopo

- `goLiveBypass/native.ts`, `index.tsx`, `vpn-controller.ts`, `vpn-proton.ts`, `vpn-windows.ts`, `vpn-linux.ts` e módulos de updater.
- `installer/GoLiveBypass-Installer.ps1` e `installer/golivebypass-installer.sh`, somente para eventos locais de detecção, escolha, preparação, build, injeção, preservação e erro.
- Testes comportamentais novos ou ajustados conforme a seção 9.

### Invariáveis

- Nenhuma chamada automática a API de bug report, webhook, Discord ou serviço de telemetria.
- Nenhuma mudança de rota, ownership, isolamento por aplicativo, relaunch, rollback ou política de segurança por causa do logger.
- O plugin continua autônomo em relação à GUI e ao standalone. O instalador continua separado do runtime WireGuard.
- Uma leitura inconclusiva continua sendo diagnóstico/informação, não autorização para encerrar recurso externo.

## 3. Contrato do evento estruturado

O arquivo local usa uma linha JSON por evento. O objeto tem somente campos conhecidos:

```json
{
  "schema_version": 1,
  "ts": "2026-09-14T16:30:12.345Z",
  "level": "info",
  "component": "plugin.native",
  "event": "vpn.activation.accepted",
  "operation_id": "activation-<opaque-id>",
  "attempt_id": "attempt-<opaque-id>",
  "phase": "active",
  "plugin_version": "2.0.6-beta-12",
  "platform": "win32",
  "arch": "x64",
  "data": {
    "mode": "proton",
    "state": "active",
    "relaunch_requested": true,
    "duration_ms": 1842
  }
}
```

### Campos obrigatórios e regras

- `schema_version`: inteiro fixo `1` nesta primeira versão.
- `ts`: timestamp UTC ISO-8601 com milissegundos.
- `level`: somente `info`, `warn` ou `error`.
- `component`: origem controlada, por exemplo `plugin.native`, `plugin.renderer`, `plugin.controller`, `plugin.helper`, `installer.windows` ou `installer.linux`.
- `event`: nome estável em minúsculas, com pontos e domínio explícito.
- `operation_id`: gerado no limite nativo da ação; nunca aceitar como identidade confiável um valor arbitrário vindo do renderer.
- `attempt_id`: novo em cada retry físico de helper, WireSock ou build; ausente em evento que não tenha tentativa.
- `phase`: fase controlada da operação, como `requested`, `preflight`, `preparing`, `starting`, `active`, `cleanup`, `restored`, `completed`, `cancelled` ou `failed`.
- `plugin_version`, `platform` e `arch`: contexto da execução, sem dados da conta.
- `data`: objeto allowlisted, tipado, limitado e redigido antes de serialização.

`request_id`, `generation` e `measurement_id` existentes podem aparecer como correlação auxiliar quando já fizerem parte do contrato da operação. Devem ser opacos/limitados e nunca substituir `operation_id`. Um relaunch pode carregar o `operation_id` por marcador local controlado, ou registrar explicitamente a relação `parent_operation_id`; não se deve inferir correlação apenas por horário ou PID.

### Vocabulário mínimo

| Domínio | Eventos mínimos | Dados úteis, sem segredo |
|---|---|---|
| Processo | `plugin.process.started`, `plugin.process.ready`, `plugin.process.shutdown` | versão, plataforma, motivo de saída |
| Ativação | `vpn.activation.requested`, `.started`, `.phase`, `.accepted`, `.failed`, `.cancelled` | modo, estado anterior/novo, relaunch, duração, causa codificada |
| Desativação | `vpn.deactivation.requested`, `.cleanup_started`, `.restored`, `.failed` | plataforma, estado, resíduos por contagem, relaunch |
| Rota | `route.discovery.started`, `.progress`, `.completed`, `.cancelled`, `.failed`; `route.selection.requested`, `.validated`, `.applied`, `.rollback`, `.failed` | filtros normalizados, contagens, servidor Proton público, país/cidade públicos, ping/velocidade, medição opaca |
| Proton | `proton.login.started`, `.challenge`, `.result`, `proton.session_check`, `proton.plan` | código estruturado, retryable, armazenamento (`safe-storage/file/memory-only`), conta presente/identidade opaca |
| Helper | `helper.started`, `.progress_sampled`, `.completed`, `.failed` | basename do executável, operação, duração, exit code, bytes, timeout, aborto, código classificado |
| WireSock/Linux | `wiresock.inspect`, `.ownership`, `.start`, `.stop`, `.diagnostic`; `linux.namespace` equivalente | origem (`plugin/gui/managed/external/mixed/unknown`), confiabilidade, serviço por nome permitido, PID/contagem, namespace/interface gerados, resultado |
| Instalador | `installer.detect.started`, `.discord_detected`, `.mod_detected`, `.checkout_candidate`, `.checkout_rejected`, `.preserved`, `.selected`, `.build`, `.inject`, `.completed`, `.failed` | quantidade, identidade (`Vencord/Equicord/unknown`), motivo codificado, fase, exit code, caminho reduzido |
| Updater | `updater.check`, `.candidate`, `.download`, `.verify`, `.stage`, `.rebuild`, `.prepared`, `.rollback`, `.reload_required`, `.failed` | canal, versão, tamanho, hash apenas como digest de artefato, resultado de allowlist/checksum, fase |
| Erro | `error.operation_failed`, `error.logger_failed` | domínio, código estável, fase, causa sanitizada e limitada |

`route.discovery.progress`, progresso do helper e diagnósticos periódicos são eventos amostrados; a transição final sempre é registrada. Os nomes existentes em texto (`ativação VPN falhou`, `probe de rota do Discord concluído`, etc.) podem ser mantidos na view textual, mas não são novos identificadores canônicos.

## 4. Níveis e semântica

- **`info`**: início/fim de operação, transição de estado, sucesso, adoção legítima, resumo de medição e update preparado.
- **`warn`**: cancelamento solicitado, retry, leitura transitória/inconclusiva, recurso externo preservado, diagnóstico `log-only`, ausência de dependência opcional ou falha não bloqueante.
- **`error`**: falha acionável, exceção não tratada da operação, quebra de contrato do helper, rollback/cleanup não confirmado, lock/owner pendente ou risco de recuperação manual.

Não registrar saúde repetitiva do watchdog como `info` a cada ciclo. Um modo `debug` não faz parte do contrato padrão; se futuramente existir, será opt-in local, temporário, com a mesma redaction e sem alterar o relatório manual padrão. Cancelamento do usuário não deve ser classificado como erro.

## 5. Redaction e privacidade

A redaction ocorre antes de construir JSON, linha textual, ring, arquivo ou relatório. O logger deve ser fail-closed para dados não reconhecidos: se um campo não puder ser classificado com segurança, registra somente presença, tipo, tamanho ou código.

### Chaves proibidas

Qualquer objeto aninhado com chave case-insensitive equivalente a `password`, `senha`, `token`, `captchaToken`, `humanVerificationToken`, `twoFactorCode`, `secret`, `privateKey`, `publicKey`, `authorization`, `cookie`, `session`, `credential`, `stdin`, `rawConfig`, `config` ou `endpoint` recebe `<redacted>` ou é omitido. A regra vale também para aliases previsíveis (`private_key`, `accessToken`, `sessionFile`, `clientSecret`).

- Senha Proton, 2FA e resposta CAPTCHA nunca são registradas.
- Tokens Proton/Discord, cookies, cabeçalhos Bearer e conteúdo de sessão nunca são registrados.
- `PrivateKey` e `PublicKey` nunca aparecem, nem em texto parcial. Configuração WireGuard, stdin e arquivos de sessão nunca entram no evento.
- Endpoint privado vira apenas `endpoint_present: true/false`; host, porta, URL, query e credenciais são omitidos.
- stdout/stderr do helper não são despejados. Registrar `stdout_bytes`, `stderr_bytes`, exit code e um `error_code` allowlisted. Uma mensagem curta só pode sair após redaction e limite.
- Caminhos locais viram `path_kind`, basename seguro ou `path_present`; segmentos de usuário, home, `LOCALAPPDATA`, checkout completo e `AllowedApps` completo não são exportados. O instalador registra somente `candidate_count`, `candidate_kind` e motivo.
- Usuário Proton não aparece em claro no log compartilhável. Usar `account_present` e, se a correlação exigir, identificador opaco estável apenas localmente; e-mail completo não é necessário.
- Servidores Proton, país, cidade, tier, ping e velocidades são metadados públicos do catálogo e podem ser registrados, desde que nunca acompanhados de endpoint ou configuração.

A mesma barreira é aplicada a mensagens livres vindas de `logFromRenderer(string)`, resultados de erro, `lastDiagnostic` e `buildReport()`. O relatório manual deve executar uma segunda redaction defensiva antes de copiar/enviar.

## 6. Retenção, dedupe e sampling

Preservar os limites operacionais atuais para não alterar o comportamento de suporte:

- `plugin-vpn.log`: máximo de 256 KiB; ao exceder, manter aproximadamente a metade mais recente, como hoje.
- ring para `getLog`: máximo de 400 eventos e teto de aproximadamente 128 KiB, mantendo a cauda mais recente.
- `getLog()` pode ler a cauda sanitizada do arquivo para sobreviver a reload/relaunch, sem ultrapassar o teto do ring/view. Falha de leitura deixa a memória disponível.
- Instaladores: cada execução mantém um `installer.log` local no diretório de dados existente (`%LOCALAPPDATA%\GoLiveBypass` ou `$XDG_DATA_HOME/GoLiveBypass`), com o mesmo teto de 256 KiB e a mesma view textual. A saída do terminal continua sendo a view imediata; não usar `Start-Transcript` nem capturar stdin/comandos crus.
- O instalador sempre pode registrar localmente, inclusive em modo `-Yes`/`--yes`, mas nenhum evento chama API, webhook ou envio automático. A abertura manual de um arquivo ou cópia da saída pelo usuário é externa a este contrato.

Dedupe colapsa somente eventos consecutivos e semanticamente idênticos, principalmente watchdog, probe saudável e falhas transitórias repetidas. O registro retido inclui `count`, `first_ts` e `last_ts`. Eventos de início/fim, mudança de estado, erro acionável, rollback, preservação externa e resultado de ativação/desativação nunca podem desaparecer por dedupe.

- Watchdog saudável: no máximo um resumo por janela de 60 s ou uma linha somente quando o estado muda.
- Probes e diagnóstico `log-only`: registrar mudança, falha ou resumo por operação; não uma linha a cada poll idêntico.
- Catálogo/rota: registrar contagens e resultado por fase; candidatos individuais somente quando selecionados, falham por motivo útil ou constituem a melhor medição. Nunca registrar endpoint.
- Helper: registrar início/fim e progresso em transições de fase ou no máximo a cada 2 s por `attempt_id`.
- Updater: preservar cada fase terminal e erro; downloads podem registrar bytes acumulados em intervalos limitados.

A ordem temporal e a relação por `operation_id` têm prioridade sobre volume. Ao atingir o limite, eventos antigos são descartados, mas a entrada mais recente de cada operação ativa e todos os terminais devem permanecer quando possível.

## 7. Compatibilidade e fluxo de dados

```text
renderer Vencord/Equicord
  Native.enable/restoreNetwork/login/route/update
       │  operation_id criado/normalizado no native
       ▼
native.ts + PluginVpnController
  eventos de domínio ──► redactor ──► JSONL local + ring
       │                                  │
       │                                  └─ getLog(): string (view textual)
       ▼
helper / WireSock / Linux / updater
  attempt_id, phase, resultado classificado

/golivebypass (ação manual)
  buildReport() ──► status + getLog() ──► redaction final ──► clipboard
                                             └─ primeiros 1.800 chars ao canal,
                                                somente pelo comando explícito

instalador Windows/Linux
  eventos locais no próprio log textual/JSONL do instalador
  sem envio automático e sem compartilhar estado com o plugin
```

### Contratos preservados

- `Native.getLog()` continua existindo e retornando `string`; o texto mantém timestamp, nível e token legível do evento para suporte e scripts que fazem busca textual.
- `Native.logFromRenderer(string)` continua aceitando mensagens legadas. Elas são encapsuladas como `plugin.renderer.message`, limitadas e redigidas. O renderer pode migrar gradualmente para eventos allowlisted, sem exigir uma mudança incompatível de IPC.
- `getVpnStatus()`, `getPluginVpnPaths()`, ações de VPN, login/seleção e objetos de updater não ganham segredos nem campos de log bruto.
- `buildReport()` continua manual, copiável e limitado; não chama rede e não envia fora do `sendBotMessage` já associado ao comando explícito. A view textual não deve expor o JSONL cru ao canal.
- `plugin-vpn.log` permanece no diretório privado atual e não é enviado automaticamente. O instalador registra em seu contexto local existente, sem misturar logs com GUI/standalone.
### Destino local dos instaladores

Os instaladores escrevem eventos no próprio `installer.log`, separado de `plugin-vpn.log`, `gui.log` e do log do standalone. A localização é `%LOCALAPPDATA%\GoLiveBypass\installer.log` no Windows e `$XDG_DATA_HOME/GoLiveBypass/installer.log` no Linux, com fallback `~/.local/share/GoLiveBypass/installer.log`. A escrita usa o mesmo envelope JSONL e redactor; o stdout/stderr exibido ao usuário é a view textual correspondente.

O fluxo de falha do instalador continua mostrando a causa e a linha do script, mas a implementação desta especificação deixa inertes as chamadas automáticas `Invoke-SendAutoReport`/`report_error`: não há POST, webhook ou envio de arquivo. A cópia da saída ou abertura do `installer.log` pelo usuário é o único caminho manual; qualquer mecanismo remoto futuro exige aprovação separada.

O arquivo de cada execução registra detecção (`candidate_count`, identidade e motivo), escolha, resultado do gate de preservação, build/injeção e conclusão. Caminhos completos, conteúdo de `app.asar`, checkout, comandos e variáveis de ambiente ficam fora do evento; uma falha de escrita deixa a saída textual disponível.

O JSONL deve ser o formato canônico para parsing futuro. A primeira entrega não exige exportador, endpoint, payload remoto ou consumidor adicional; o `installer.log` definido acima é o único arquivo novo e o formatter textual é uma compatibilidade deliberada, não uma segunda semântica.

## 8. Erros e comportamento degradado

1. Validar/normalizar o evento e aplicar redaction antes de qualquer stringify.
2. Se o evento for inválido, registrar `error.logger_failed` contendo apenas componente, fase e código `INVALID_EVENT`; nunca lançar ao chamador.
3. Se o arquivo não puder ser criado/escrito, manter o ring em memória e registrar no máximo uma advertência deduplicada; nunca bloquear ativação, desativação, helper ou Discord.
4. Se JSONL não puder ser serializado, usar a view textual sanitizada com campos mínimos. Se ambas falharem, descartar o diagnóstico e preservar a operação funcional.
5. Se uma mensagem do helper contiver formato inesperado, classificar por código/exit code e bytes, sem copiar stdout/stderr.
6. Se a redaction encontrar valor proibido em uma view final, substituir o valor e marcar `redaction_applied: true`; não abortar uma operação VPN. Para o relatório manual, uma falha na barreira deve impedir o envio/cópia daquele bloco, seguindo o princípio fail-closed do relatório, sem remover a capacidade do túnel de continuar.
7. Erros de operação devem registrar evento terminal exatamente uma vez por `operation_id`; retries ficam associados por `attempt_id`.

## 9. Testes comportamentais sem credenciais reais

Os testes devem usar helpers, processos e respostas sintéticos; não usar conta Proton, senha real, token real, endpoint real, rede, Discord real, VM ou canal real.

### Redaction e privacidade

- Dados aninhados com todas as chaves proibidas, aliases, URL com usuário/senha, `Authorization: Bearer`, sessão, configuração WireGuard, `PrivateKey`, `PublicKey`, endpoint e stdout/stderr sintéticos.
- Provar que nenhum valor original aparece no JSONL, ring, `getLog()` ou `buildReport()`; endpoint resulta somente em `endpoint_present` ou ausência.
- Provar que caminhos Windows/POSIX, home, checkout e `AllowedApps` não carregam nome pessoal completo.
- Provar que mensagens livres de `logFromRenderer` são limitadas, encapsuladas e redigidas.

### Correlação e ciclo de vida

- Ativação Windows/Linux sintética com sucesso, retry, cancelamento, falha de helper, falha de relaunch e rollback; verificar um `operation_id`, `attempt_id` distinto por retry e evento terminal.
- Desativação com recurso próprio, externo, misto, desconhecido e cleanup incompleto; verificar preservação externa, `warn` para diagnóstico e `error` somente para restauração não confirmada.
- Respostas atrasadas de gerações anteriores não podem produzir eventos terminais na operação atual.

### Proton/helper/rota

- Helper falso emitindo progresso, JSON válido, JSON inválido, exit code não zero, timeout, spawn error e cancelamento; verificar eventos start/progress/result/failure com duração/bytes/código, sem conteúdo bruto.
- Login falso com códigos de credencial, 2FA, CAPTCHA, rede, timeout, storage, cancelamento e helper; verificar que os códigos permanecem distintos e que nenhum segredo é logado.
- Descoberta e seleção manual com candidatos sintéticos, medição expirada, cancelamento, servidor selecionado, falha e rollback; verificar contagens e metadados públicos sem endpoint.

### WireSock/Linux/updater/instaladores

- Snapshots WireSock sintéticos (plugin, GUI/managed, external, mixed, unknown), processo sem CommandLine e estado transitório; verificar eventos de inspeção/ownership e ausência de comandos completos.
- Linux com dependências ausentes, autorização cancelada, namespace próprio e recurso externo; verificar classificação e ausência de prompt/ação não autorizada.
- Updater falso com release ausente, download limitado, checksum inválido, archive inseguro, build falho, rollback, pendência e reload manual; verificar cada fase e nenhuma reinicialização silenciosa.
- Instalador Windows/Linux com identidade Vencord/Equicord detectada sem checkout, checkout em caminho não pesquisado, `-Source` válido, parser sem `require`, build/injeção falhos e preservação; verificar que #293 é distinguível por fase/motivo e que `app.asar`/`_app.asar` permanecem intactos no gate.

### Retenção e compatibilidade

- Emitir milhares de watchdog/probe/progresso e provar limites do arquivo/ring, `count/first_ts/last_ts`, preservação dos eventos terminais e leitura da cauda após simular novo processo.
- Provar que `getLog()` continua sendo string, contém nível e token textual dos eventos, que `buildReport()` permanece limitado e que nenhuma função de logger realiza rede.
- Provar que falha de mkdir/write/stringify/redaction não lança para o fluxo da VPN e deixa o Discord continuar.

## 10. Riscos e decisões

- **Risco de quebra de consumidores textuais:** mitigado mantendo `getLog(): string`, tokens legíveis e o mesmo arquivo. A migração deve adicionar JSONL sem remover a view na primeira versão.
- **Risco de vazamento por novos campos:** mitigado por allowlist, redaction recursiva e segunda barreira no relatório; não aceitar dumps genéricos de objetos.
- **Risco de volume:** mitigado por ring/arquivo atuais, dedupe e sampling por domínio; erros e terminais não são amostrados.
- **Risco de correlação falsa após relaunch:** usar relação explícita entre operação/parent operation ou registrar a quebra de processo; não correlacionar por proximidade temporal.
- **Risco de diagnóstico incompleto do #293:** eventos de descoberta devem registrar motivo de rejeição classificado, não caminho completo. O design não promete descobrir automaticamente qualquer checkout.
- **Risco de misturar arquiteturas:** plugin, GUI, standalone e instaladores têm componentes distintos; cada `component` identifica sua origem e não há promessa de paridade automática.

## 11. Não-escopo

- Telemetria, webhook, API, envio automático, coleta em segundo plano ou armazenamento remoto.
- Nenhum mecanismo remoto de relatório ou telemetria é mantido ou ampliado nesta entrega; chamadas automáticas dos instaladores são explicitamente inertes. Um fluxo remoto futuro, mesmo para bug report, exige nova decisão e aprovação.
- Alteração de WireGuard/WireSock, WFP, namespace, rotas, Proton, credenciais, updater, política de relaunch ou comportamento do Discord.
- Substituição do mecanismo manual `/golivebypass`, criação de modal novo ou envio de screenshot/anexo.
- Resolver a causa desconhecida do checkout específico da #293 sem evidência adicional; o design apenas torna a fase/motivo observável.
- Reativar standalone, proxy/PAC/Tor, injeção `app.asar` no runtime ou compartilhar estado entre GUI, plugin e standalone.
- Logging de endpoint privado, chave, senha, token, sessão, conteúdo de perfil ou linha de comando completa sob qualquer justificativa.
