# Descoberta de instalações Discord no Windows — Implementation Plan

> Plano derivado da especificação aprovada em `docs/superpowers/specs/2026-09-15-discord-discovery-design.md`.
> Este plano cobre somente a issue #300. Cada commit de implementação deve conter apenas os arquivos da fase correspondente e preservar alterações não relacionadas do worktree.

**Goal:** fazer a GUI Windows localizar instalações Discord/DiscordPTB/DiscordCanary/Vesktop/Equibop/Legcord fora das raízes atuais de `%LOCALAPPDATA%`, inclusive instalações paradas conhecidas por registro/atalho e instalações em execução conhecidas por `ExecutablePath`, sem varrer discos.

**Architecture:** manter `getWinDiscordInstalls()` síncrona e compatível com os consumidores atuais. Um módulo novo concentra o contrato schema=1, o parser puro e os adapters bounded de processo/registro/atalho/raiz. `main.ts` recebe somente `DiscordInstall` com `exePath` absoluto validado. O cache usa TTL de quatro segundos e stale de no máximo oito segundos apenas em status/watchdog; qualquer lifecycle força descoberta fresca antes de `killDiscord()`. `windowsAllowedAppPaths()` não será alterado.

**Tech Stack:** Electron 43, Node/TypeScript, PowerShell 5.1, `original-fs`, `shell.readShortcutLink()`, Vitest, VM Windows para smoke. Nenhuma dependência nova.

## Restrições globais

- Não ler, escrever, renomear ou validar `app.asar` como parte da descoberta.
- Não alterar `windowsAllowedAppPaths()` nem `formatAllowedApps()`. A descoberta fornece `exePath`; a expansão já existente de diretório, subprocessos e updater permanece intocada.
- Não alterar macOS, Linux em produção, plugin, standalone, WireSock, kill por nome ou UI de seleção.
- Não executar strings de registro ou argumentos de atalhos. Argumentos de `.lnk` são lidos apenas em memória.
- Não fazer `readdir` recursivo, busca por nome em volume ou inventário irrestrito do computador.
- Não incluir caminho UNC, device path, ADS, argumentos ou executável que não esteja na allowlist de seis flavours.
- Preservar múltiplas instalações: deduplicar somente por `exePath` canonicalizado; roots distintos do mesmo flavour permanecem e a semântica atual continua iniciando todos os resultados.
- `detectedBy` é metadado interno do pipeline/diagnóstico. Removê-lo ao construir o `DiscordInstall` público, cujo contrato atual não muda.
- Candidato descoberto por processo deve ser retido antes de qualquer `killDiscord()`; não depender de novo scan depois que o processo terminou.
- Não executar builds, testes ou smoke durante a implementação de outra fase. A validação final deve ser feita uma vez pelos comandos da fase 7.

## Interfaces e seams finais

O módulo novo `golive-gui/electron/windows-discord-discovery.ts` deve expor interfaces pequenas para que todos os testes rodem em Linux sem executar PowerShell, Electron Shell ou Windows:

```ts
export type WindowsDiscoveryFlavour =
  | "Discord" | "DiscordPTB" | "DiscordCanary"
  | "Vesktop" | "Equibop" | "Legcord";

export type DiscoverySource = "root" | "process" | "registry" | "shortcut";
export type DiscoveryBlockStatus = "ok" | "empty" | "partial" | "error";

export interface WindowsDiscoveryEnvironment {
  LOCALAPPDATA?: string; APPDATA?: string; USERPROFILE?: string;
  PUBLIC?: string; ProgramData?: string; ProgramFiles?: string;
  "ProgramFiles(x86)"?: string; ProgramW6432?: string;
}

export interface WindowsDiscoveryCollectors {
  collectPowerShell: () => WindowsDiscoveryRaw;
  listDirectory: (root: string) => string[];
  exists: (file: string) => boolean;
  isFile: (file: string) => boolean;
  realpath?: (file: string) => string;
  readShortcut: (file: string) => { target: string; args: string };
}

export interface WindowsDiscoveryCacheDeps {
  nowMs: () => number;
  readEnv: () => WindowsDiscoveryEnvironment;
  rootsForEnv: (env: WindowsDiscoveryEnvironment) => string[];
  collectFresh: (
    env: WindowsDiscoveryEnvironment,
    roots: string[],
  ) => WindowsDiscoverySnapshot;
}

export interface WindowsDiscoveryCache {
  read(options?: { forceRefresh?: boolean; allowStale?: boolean }): WindowsDiscoverySnapshot;
  invalidate(): void;
}
```

`createWindowsDiscoveryCache(deps)` e as funções `parseWindowsDiscoveryJson()`/merge/validação serão puras: o cache usa somente `nowMs`, `readEnv`, `rootsForEnv` e `collectFresh` injetados, com TTL de quatro segundos e stale de oito segundos. O adapter de produção em `main.ts` adapta `process.env`, `diskFs`, `execFileSync` e `shell.readShortcutLink` e chama essa API; o módulo não lê ambiente global nem importa `electron`. O parser de JSON e o merge não executam comandos. Os testes usam paths Windows artificiais (`path.win32`) e callbacks em Linux.

## Fase 1 — Contrato comum, normalização e parser puro

**Arquivos:**

- Criar `golive-gui/electron/windows-discord-discovery.ts`.
- Ler `golive-gui/electron/windows-discord-install.ts`; manter `findWindowsDiscordInstall()` compatível.
- Criar `golive-gui/tests/windows-discord-discovery.test.ts`.

**Símbolos a criar:**
- `WindowsDiscoveryRaw`, `WindowsDiscoveryRawProcessRow`, `WindowsDiscoveryRawRegistryRow` e `WindowsDiscoverySnapshot`.
- `WindowsDiscoveryCandidate` interno com `source`, `flavour`, `exePath`, `appDir`, `resources` e `detectedBy`.
- `parseWindowsDiscoveryJson(raw: string): WindowsDiscoveryRaw`.
- `normalizeWindowsDiscoveryPath(raw: string, context: "process" | "value" | "displayIcon"): string | null`.
- `flavourFromExecutableName(name: string): WindowsDiscoveryFlavour | null`.
- `validateWindowsExecutable(path: string, flavour: WindowsDiscoveryFlavour, fsSeam): string | null`.
- `createWindowsDiscoveryCache(deps)` e `read(options)`/`invalidate()` com relógio, ambiente e roots injetáveis.

**Contrato schema=1:**

- Top-level `schema` deve ser exatamente `1`.
- `process` e `registry` sempre possuem `status`, `rows`, `truncated`; `errorCode` é opcional para `error`/`partial`.
- `process.rows` contém apenas `{ name, pid, path }`.
- `registry.rows` contém `{ hive, kind, value, flavourHint? }`, com `kind` exatamente `app-paths | uninstall | url-handler`; somente `uninstall` pode trazer `displayIcon?` e `installLocation?`.
- `value` é o DEFAULT de App Paths, URL handler ou subchave Uninstall. JSON válido, inclusive vazio/parcial, corresponde a exit code 0; código não-zero do coletor é erro catastrófico e vira `errorCode` no adapter.
- `flavourHint` de App Paths/URL handler vem somente do mapa constante; em Uninstall vem de `DisplayName` allowlistado ou caminho inequívoco.

**Normalização:**

1. Cortar espaços externos e rejeitar NUL, controles, quebras, aspas internas, vírgula restante, argumentos, UNC, device path e ADS.
2. Para `value` de App Paths/URL handler, ler somente o primeiro token; remover aspas apenas se delimitarem esse token. Nunca aceitar/remover `,0` em `value`.
3. Para `displayIcon`, ler o primeiro token e remover somente o sufixo final `,0` desse token. Não aplicar essa regra a outro campo.
4. Exigir path absoluto com letra de drive e basename `.exe` exato na allowlist case-insensitive.
5. Verificar arquivo regular com `exists` + `isFile`; canonicalizar para comparação e resolver `realpath` quando o seam fornecer.
6. Para processo, aceitar parent `app-*` sem exigir ancestral com nome flavour (inclui `D:\MyDiscord\app-1.0.10\Discord.exe`) ou executável direto com `resources` ao lado.
7. Para registro/atalho, nunca aceitar o executável indicado diretamente como `Update.exe`; usar apenas sua raiz bounded e `findWindowsDiscordInstall()` para achar o flavour direto/app-* imediato.

**Dedupe/precedência:** implementar `mergeWindowsDiscoveryCandidates()` com prioridade por mesmo `exePath`: `process > root > registry > shortcut`. Deduplicar apenas pelo path canonicalizado, preservando paths diferentes do mesmo flavour e todos os installs públicos. Remover `detectedBy` no mapper final para `DiscordInstall`.

**Testes da fase:**

- Parser rejeita schema desconhecido, tipos errados e rows inválidos sem aceitar candidatos parciais.
- `value` com `Discord.exe,0` não sofre remoção de `,0`; `displayIcon` com `"Update.exe,0"` remove somente o marcador esperado.
- `flavourHint` desconhecido ou discordante não cria flavour.
- Paths customizados, parent `app-*`, direct+resources, basename falso, UNC, ADS, args e arquivo ausente exercitam o validador.
- Dedupe preserva duas roots distintas do mesmo flavour e escolhe a origem de maior prioridade somente para o mesmo path.
- Cache puro: usar `nowMs` injetado para testar TTL de quatro segundos, stale máximo de oito segundos e `forceRefresh`, sem importar Electron nem depender do relógio/ambiente do processo.

```bash
npm test -- tests/windows-discord-discovery.test.ts
```

## Fase 2 — Coletor PowerShell e handlers de processo/registro

**Arquivos:**

- Modificar `golive-gui/electron/windows-discord-discovery.ts` como o único módulo de discovery/PowerShell; não criar módulo PowerShell alternativo.
- Criar/atualizar `golive-gui/tests/windows-discord-discovery.test.ts` com fixtures do stdout.

**Símbolos a criar:**

- `WINDOWS_DISCOVERY_FLAVOURS` constante.
- `buildWindowsDiscoveryPowerShell(): string`.
- `collectWindowsDiscoveryPowerShell(): WindowsDiscoveryRaw`.
- `parseProcessRows()` e `parseRegistryRows()`.
- `handleProcessRows()` e `handleRegistryRows()`.

**PowerShell:**

- Invocar `powershell.exe` via `execFileSync`, `-NoProfile`, `-NonInteractive`, `windowsHide: true`, timeout de 3000 ms e script constante. Preferir `-EncodedCommand` para quoting seguro.
- Consultar `Win32_Process` apenas pelos seis nomes literais; selecionar somente `Name`, `ProcessId`, `ExecutablePath`. Não coletar `CommandLine`.
- Consultar App Paths em HKCU/HKLM/WOW6432Node para os seis executáveis.
- Consultar URL handlers constantes em:
  `HKCU\Software\Classes\<scheme>\shell\open\command`,
  `HKLM\Software\Classes\<scheme>\shell\open\command` e a visão WOW6432Node quando aplicável, para `discord`, `discordptb`, `discordcanary`, `vesktop`, `equibop`, `legcord`.
- Consultar apenas os subitens dos roots Uninstall de HKCU, HKLM e WOW6432Node, com teto de 128 subchaves por hive/root. Filtrar por `DisplayName` allowlistado e campos que apontem para flavour.
- Emitir `value` DEFAULT; para Uninstall preservar também `DisplayIcon` e `InstallLocation`.
- Forçar arrays com `@()` para compatibilidade PowerShell 5.1. Limitar rows; ao atingir teto, marcar `status=partial` e `truncated=true`. A ordem de enumeração Uninstall não é garantida e o corte pode ocorrer antes do Discord.
- Cada bloco captura seu próprio erro e usa `status=error`/`errorCode`. JSON válido vazio ou parcial sai 0; só impossibilidade catastrófica de gerar JSON produz exit code não-zero.

**Handlers:**

- Processo: transformar cada `ExecutablePath` válido em candidato direto; ignorar path nulo/inacessível sem declará-lo parado.
- App Paths: extrair primeiro token de `value` sem a regra `,0`; aceitar somente basename flavour.
- URL handler: ler primeiro token sem executar a command string; aceitar flavour direto ou `Update.exe` apenas quando os tokens em memória contiverem exatamente `--processStart <flavour>.exe`; derivar root do updater e chamar finder bounded.
- Uninstall: usar `DisplayIcon` com regra exclusiva `,0`, depois `InstallLocation`; tratar ambos como indício/fallback. Nunca depender somente de Uninstall, pois o teto pode truncar antes da entrada Discord.

**Testes da fase:**

- Fixtures JSON com processo zero/um/vários, path nulo, erro parcial, `truncated` e código catastrófico.
- Fixtures para DEFAULT de App Paths e URL handler, incluindo valores com espaços e comando URL com `--processStart` exato.
- Fixtures de Uninstall com HKCU/HKLM/WOW, `DisplayIcon`, `InstallLocation`, DisplayName permitido/não permitido e 129 subchaves com truncamento antes do row Discord.
- Assertar que nunca se registra ou executa `CommandLine`, argumentos ou exceção/stdout bruto.

```bash
npm test -- tests/windows-discord-discovery.test.ts
```

## Fase 3 — Roots bounded e adapter de atalhos

**Arquivos:**

- Modificar `golive-gui/electron/windows-discord-discovery.ts`.
- Manter `golive-gui/electron/windows-discord-install.ts` sem mudança de contrato; alterar apenas se for necessário expor uma primitiva de finder bounded.
- Atualizar `golive-gui/tests/windows-discord-install.test.ts`.
- Atualizar `golive-gui/tests/windows-discord-discovery.test.ts`.

**Roots:**

Gerar combinações somente com valores não vazios e distintos de:

- `%LOCALAPPDATA%\<flavour>` e `%LOCALAPPDATA%\Programs\<flavour>`;
- `%ProgramFiles%\<flavour>` e `%ProgramFiles%\Programs\<flavour>`;
- `%ProgramFiles(x86)%\<flavour>` e `%ProgramFiles(x86)%\Programs\<flavour>`;
- `%ProgramW6432%\<flavour>` e `%ProgramW6432%\Programs\<flavour>`.

A ordem fixa deve ser documentada e estável. Cada root chama apenas `findWindowsDiscordInstall()` com `exists/listDirectory` injetáveis; é proibido percorrer descendentes além de `app-*` imediato.

**Atalhos:**

- Adapter separado de PowerShell, usando `shell.readShortcutLink` injetável.
- Exatamente quatro raízes: `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, `%ProgramData%\Microsoft\Windows\Start Menu\Programs`, `%USERPROFILE%\Desktop`, `%PUBLIC%\Desktop`.
- Start Menu aceita `dir\*.lnk` e exatamente um subnível vendor `dir\*\*.lnk`; Desktop aceita somente links diretos. Sem segundo subnível, symlink traversal ou recursão.
- Filtrar nomes por flavour; limitar a 64 links por raiz e 64 por subdiretório vendor. Ao atingir limite, registrar `partial/truncated` no diagnóstico do handler.
- Ler `target` e `args` somente em memória. Target basename flavour `.exe` é candidato; target `Update.exe` só é aceito com args contendo exatamente `--processStart <flavour>.exe`, para derivar root bounded. Nunca passar args a `spawn` nem a PowerShell.
- Link quebrado, erro de leitura e formato malformado são falhas parciais, não abortam outras fontes.

**Testes da fase:**

- Fixtures em diretórios temporários com raízes diretas e `app-*`; confirmar ausência de necessidade de `app.asar` e seleção numérica existente.
- Seam `listDirectory` registra chamadas e prova que não houve recursão nem volume inteiro.
- Seam `readShortcut` cobre target direto, Update com argumento exato, argumento extra/malformado, link quebrado e limite 64/raiz/vendor.
- Verificar que os quatro roots e o padrão exato `dir/*/*.lnk` são aplicados.

**Validação planejada:**

```bash
npm test -- tests/windows-discord-install.test.ts tests/windows-discord-discovery.test.ts
```

## Fase 4 — Integração em `main.ts`, cache e snapshots de lifecycle

**Arquivos:**

- Modificar `golive-gui/electron/main.ts`.
- Modificar `golive-gui/tests/ativacao-guard.test.ts` apenas para preservar/estender contratos de integração, inclusive asserções inline existentes.
- Adicionar casos a `golive-gui/tests/windows-discord-discovery.test.ts` para cache/mapper, sem importar o app Electron.

- Remover o early-return que hoje faz `getWinDiscordInstalls()` retornar `[]` quando `LOCALAPPDATA` está ausente. Sem esse ambiente, pular somente roots que dependem dele e ainda executar os handlers de processo, registro e atalhos.
- Substituir o corpo de `getWinDiscordInstalls()` por chamada ao discovery/cache e mapper que remove `detectedBy`, preservando `DiscordInstall { flavour, resources, exePath, bundlePath? }`.
- O wrapper de `getWinDiscordInstalls()` deve preservar `withNoAsar()` e `original-fs`/`diskFs`; `main.ts` apenas adapta ambiente, filesystem e collectors para a API pura do módulo.
- Não alterar `windowsAllowedAppPaths()`. Adicionar teste de integração que captura o candidato discovery, verifica que o mesmo `exePath` absoluto chega sem alteração à entrada de `windowsAllowedAppPaths()` e que a expansão existente continua presente.
- O teste de integração com ambiente sem `LOCALAPPDATA` deve provar que `getWinDiscordInstalls()` não retorna cedo: pula somente roots dependentes de `LOCALAPPDATA` e ainda chama os handlers de processo, registro e atalhos.
- `getDiscordInstalls()` continua sem alteração para Linux e Mac além do dispatch Windows existente.
- `discordProcessState()` e `waitUntilDiscordRunning()` continuam separados para liveness por `tasklist`; falha CIM não vira stopped.

- O cache é criado pelo componente puro `createWindowsDiscoveryCache()` em `windows-discord-discovery.ts`; `main.ts` não usa `Date.now()`/`process.env` diretamente para decidir TTL e não implementa cache paralelo.
- Usar `readEnv`, `rootsForEnv` e `nowMs` injetados; a chave contém `platform` e os valores de `LOCALAPPDATA`, `APPDATA`, `USERPROFILE`, `PUBLIC`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)` e `ProgramW6432`.
- `%ProgramW6432%` entra nas roots quando não vazio e diferente das outras; qualquer mudança de valor ou igualdade/diferença invalida o cache.
- TTL único de quatro segundos. Stale máximo de oito segundos.
- Stale é elegível somente em `getStatus()` e no caminho de diagnóstico `startWindowsRouteWatchdog()` → `diagnoseWindowsRoute()`. Nenhuma operação lifecycle usa stale.
- `forceRefresh` obrigatório antes de ativação, desativação, `restore-internet`, troca manual de rota, otimização/troca Proton, failover e cada rollback. PowerShell continua síncrono, mas bloqueia a thread principal no máximo três segundos e no máximo uma vez por TTL; não há busca aberta/background.
- Em erro de coleta, lifecycle usa somente dados frescos das fontes que responderam; status/watchdog pode reutilizar snapshot stale até oito segundos. Nunca transformar stale/erro em lista vazia silenciosa.

### Captura antes de kill

- `executarAtivacao()`: force refresh e capture `installs` antes de `killDiscord()`; reutilize a lista para perfil, WireSock e start.
- `deactivateAll()`: force refresh antes da captura já existente; reutilize após recuperação.
- `ipcMain.handle("restore-internet")`: quando `hadWireSock`, force refresh/capture antes do kill e reutilize no restart; não rescaneie apenas pelo processo depois do kill.
- `ipcMain.handle("select-proton-route")` / `applyProtonRouteResult()`: force refresh/capture antes de matar o cliente e reutilize a variável no rollback, eliminando rescan posterior ao kill.
- `ipcMain.handle("optimize-proton-route")` / caminho de aplicação Proton em torno de `applyProtonRouteResult()` (~4206): force refresh antes de qualquer kill e reutilize o snapshot nos caminhos de falha/rollback.
- `applyProtonFailoverCandidate()`: force refresh/capture antes da troca que possa encerrar cliente e reutilize em falhas/rollback.
- Rollback de ativação, restauração e troca de rota nunca usa snapshot stale; se não houver candidato fresco, falha de forma segura sem iniciar executável desconhecido.

**Testes da fase:**

- Cache puro em Linux, sem Electron: usar `nowMs` controlado para provar TTL exato 4s, stale máximo 8s somente quando `allowStale=true`, expiração e `forceRefresh`.
- Testar chave/invalidação por cada env/root, incluindo ausência de `LOCALAPPDATA` e mudança de `%ProgramW6432%`.
- Snapshot process-only permanece disponível depois de simular `killDiscord()` e é o mesmo usado no restart/rollback.
- Atualizar/re-pinar explicitamente `golive-gui/tests/ativacao-guard.test.ts:257`, na asserção de restore que hoje espera `startDiscordAndConfirm(getDiscordInstalls(), "restaurar-internet")`: a expectativa deve provar que a variável foi capturada antes de `killDiscord()` e reutilizada, não um novo `getDiscordInstalls()` posterior. Localizar e conferir outros testes inline semelhantes que contenham `startDiscordAndConfirm(getDiscordInstalls(), ...)` ou rescans após kill e ajustar somente as expectativas necessárias.
- Testes fonte/estrutura continuam afirmando ordem `killDiscord` antes de WireSock e snapshot antes do kill em restore/rollback.
- Teste comprova que `windowsAllowedAppPaths()` não foi alterado e recebe o `exePath` exato do discovery.

**Validação planejada:**

```bash
npm test -- tests/windows-discord-discovery.test.ts tests/ativacao-guard.test.ts
```

## Fase 5 — Observabilidade e changelog

**Arquivos:**

- Modificar `golive-gui/electron/discordscan.ts`.
- Modificar `golive-gui/electron/main.ts` nos pontos que registram discovery, sem alterar comportamento de outros SOs.
- Modificar `CHANGELOG.md` somente se a implementação alterar o formato/conteúdo observável de `scan.raiz` ou `scan.install`.
- Atualizar `golive-gui/tests/logger.test.ts` ou `redact.test.ts` somente para uma regra comportamental nova, se necessária.

**Eventos:**

- Registrar `source`, `status`, `flavour`, `detected_by` interno, contagem, `truncated` e `errorCode` estável.
- Não registrar `ExecutablePath` bruto, `CommandLine`, args de atalho, stdout/stderr PowerShell, chave completa de registro, segredo ou exceção inteira.
- Como `scanRaiz()`/`scanInstall()` usam `logger.info` direto, sanitizar antes da chamada; usar placeholder `<usuario>`, categoria/hash curto e clipping, não depender apenas de `logger.logEvent`.
- Manter `bugreport.ts`/`redact.ts` como segunda barreira, sem enviar dados crus para que ela os limpe depois.
- Se `scan.raiz` ou `scan.install` mudar de caminho completo para resumo/hash, registrar no `CHANGELOG.md` a sanitização dos diagnósticos e a compatibilidade do novo formato.

**Testes da fase:**

- Assertar ausência de username/path custom, commandline, args e conteúdo de stdout em logs.
- Assertar campos permitidos, truncamento e códigos de erro por fonte.
- Não adicionar teste que fixe texto incidental se a garantia puder ser testada por invariantes de redaction.

**Validação planejada:**

```bash
npm test -- tests/logger.test.ts tests/redact.test.ts tests/windows-discord-discovery.test.ts
```

## Fase 6 — Testes permanentes de integração

- Consolidar `golive-gui/tests/windows-discord-discovery.test.ts`.
- Manter/estender `golive-gui/tests/windows-discord-install.test.ts`.
- Manter/estender `golive-gui/tests/ativacao-guard.test.ts`.
- Não alterar `golive-gui/tests/wiresock.test.ts` para remover a expectativa existente de diretório: AllowedApps está fora do escopo.
- Os testes de TTL/stale do cache devem permanecer Linux-only por meio de `nowMs`, `readEnv`, `rootsForEnv` e `collectFresh` injetados; não importar `main.ts` nem Electron.

**Cobertura mínima permanente:**

1. Raízes atuais e Program Files, incluindo ProgramW6432 distinto; direct e `app-*` sem `app.asar`.
2. Processo externo em `D:\MyDiscord\app-1.0.10\Discord.exe`, direct+resources, path nulo, basename falso, arquivo ausente, UNC/ADS/args.
3. Parser schema=1 para arrays de zero/um elemento, erro de bloco, partial/truncated e código catastrófico.
4. DEFAULT de App Paths/URL handler e `DisplayIcon`/`InstallLocation` de Uninstall, com semântica distinta de `,0`.
5. URL schemes e roots de registro constantes; HKCU/HKLM/WOW; teto 128 Uninstall e truncamento antes do Discord.
6. Shortcut target direto, Update com `--processStart <flavour>.exe`, args somente em memória, link quebrado, quatro raízes e exatamente um nível vendor.
7. Precedência process > root > registry > shortcut; dedupe somente por exePath; dois roots do mesmo flavour preservados e ambos iniciáveis.
8. Cache TTL 4s/stale 8s, stale somente `getStatus()` e `startWindowsRouteWatchdog()` → `diagnoseWindowsRoute()`, forceRefresh em lifecycle e chave completa de env/roots.
9. Snapshot process-only capturado antes de `killDiscord()` e reutilizado em restore e todos rollbacks relevantes.
10. `exePath` do discovery chega sem alteração ao builder `windowsAllowedAppPaths()`; contrato de AllowedApps continua igual.
11. Logs sanitizados e changelog condicional quando scan.raiz/scan.install mudarem.

Os testes de parser/merge/limites devem rodar em Linux por seams injetáveis. Nenhum teste unitário deve depender de `process.platform=win32`, PowerShell real, Electron Shell ou um disco Windows.

## Fase 7 — Smoke Windows e validação final

**Preparação:** executar em VM Windows descartável, sem publicar artefatos. Não executar nesta fase qualquer alteração de registro/atalho fora dos fixtures e da operação controlada do teste.

1. Instalação real em `Program Files` fora de `%LOCALAPPDATA%`, parada: confirmar descoberta por root/registro/atalho e `exePath` absoluto.
2. Instalação externa em `D:\MyDiscord\app-<versão>`, aberta: confirmar descoberta por `Win32_Process.ExecutablePath`.
3. Instalação sem registro/atalho: confirmar que só é encontrada durante execução e não inventar cold-start por busca de disco.
4. Iniciar bypass e conferir no log que o candidato correto foi usado; validar o perfil/AllowedApps pelo contrato existente, sem exigir alteração de `windowsAllowedAppPaths`.
5. Desativar, restaurar internet e reiniciar todos os clientes descobertos; confirmar que a lista capturada antes de `killDiscord()` foi reutilizada.
6. Trocar rota Proton manual/automática e provocar rollback; confirmar que o cliente externo volta pelo mesmo snapshot e que nenhum caminho process-only é perdido.
7. Simular/observar fonte parcial (Uninstall truncado, shortcut quebrado ou CIM sem path); confirmar que outras fontes ainda detectam o cliente.
8. Confirmar ausência de varredura recursiva, bloqueio acima de três segundos por chamada PowerShell e dados crus nos logs/report.
9. Forçar falha de cópia/preparação do probe em `Program Files` e confirmar que `discord-scope-proof` permanece best-effort/log-only e não bloqueia ativação, desativação, restore, troca de rota ou rollback.

**Comandos de validação finais (não executar como parte deste documento):**

```bash
cd golive-gui
npm test -- tests/windows-discord-install.test.ts tests/windows-discord-discovery.test.ts tests/ativacao-guard.test.ts tests/logger.test.ts tests/redact.test.ts
npm run compile
cd ..
```

No Windows, executar também o smoke/contrato já existente conforme o procedimento do projeto, sem publicar:

```powershell
# No checkout da GUI, após os testes locais
npm run compile
npm run build:win
```

O build Windows é validação de implementação e não deve ser executado durante a elaboração deste plano. O relatório final deve separar testes unitários Linux de evidência real Windows e registrar limitações da VM.

## Critérios de aceite

- A issue #300 reproduzida com cliente externo parado deixa de resultar em `installs=0` quando registro/atalho/root conhecido fornece o executável.
- Cliente externo em execução é encontrado pelo `ExecutablePath`, inclusive em `D:\MyDiscord\app-1.0.10\Discord.exe` sem ancestral com nome flavour.
- `registry.rows.value`, `kind`, status/truncated e exit codes obedecem schema=1; `,0` só é normalizado para token de `displayIcon`.
- Uninstall é bounded, pode truncar antes do Discord e nunca é fonte única; App Paths, URL handlers, processo e atalhos continuam consultados.
- Roots incluem `%ProgramW6432%` quando distinto; cache também invalida por esse valor.
- Dedupe é somente por `exePath`; roots distintos do mesmo flavour são preservados e a semântica atual inicia todos, sem UI nova.
- TTL é exatamente 4s; stale máximo 8s é usado exclusivamente por `getStatus()` e `startWindowsRouteWatchdog()` → `diagnoseWindowsRoute()`; lifecycle sempre usa `forceRefresh`.
- Restore, desativação, troca Proton/manual/failover e todos os rollbacks capturam snapshot fresco antes de `killDiscord()` e reutilizam-no depois.
- `exePath` validado chega sem alteração ao builder de `AllowedApps`; `windowsAllowedAppPaths()`/AllowedApps não foram alterados.
- Nenhum scan recursivo ou busca aberta/background é introduzido; o PowerShell síncrono bloqueia a thread principal no máximo três segundos por chamada e uma vez por TTL.
- Logs de discovery não expõem paths crus, command line, args ou stdout; qualquer mudança de `scan.raiz`/`scan.install` é documentada no changelog.
- Linux/macOS/plugin/standalone permanecem sem alteração de comportamento.

## Commits planejados

Cada commit deve ser isolado e incluir somente seus arquivos da fase:

1. `feat(gui): adicionar parser e seams da descoberta Windows`
2. `feat(gui): coletar processo e registro Discord no Windows`
3. `feat(gui): descobrir raízes e atalhos Windows bounded`
4. `feat(gui): integrar discovery e snapshots de lifecycle`
5. `fix(gui): sanitizar diagnóstico da descoberta Windows`
6. `test(gui): cobrir descoberta externa do Discord`

Não criar commit de build, artefatos ou alterações não relacionadas. A decisão de alterar `scan.raiz`/`scan.install` exige a entrada correspondente no `CHANGELOG.md`; caso o formato existente seja preservado com sanitização aplicada antes do logger, nenhum changelog adicional é necessário além do registro da correção principal.
