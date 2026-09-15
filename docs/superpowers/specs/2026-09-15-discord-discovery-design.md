# Descoberta de instalações Discord no Windows

## Problema e evidência

A issue [#300](https://github.com/bezumiya/GoLiveBypass/issues/300) relata a GUI Windows `2.0.6-beta-17` com `LOCALAPPDATA` presente, mas `installs=0`. O log registra `existe=nao` para todas as raízes testadas:

- `%LOCALAPPDATA%\Discord` e `%LOCALAPPDATA%\Programs\Discord`;
- `DiscordPTB`, `DiscordCanary`, `Vesktop`, `Equibop` e `Legcord` nos mesmos dois formatos.

O resultado repetido foi `scan.resultado | total=0`, seguido de `ativacao.sem_discord` e `Nenhum Discord encontrado.`. Portanto, a varredura atual não falhou por ausência de `LOCALAPPDATA`; ela tem um conjunto fixo de raízes que não representa todas as instalações Windows.

Hoje `golive-gui/electron/main.ts:getWinDiscordInstalls()` só testa essas raízes e delega a validação de cada uma para `findWindowsDiscordInstall()`. Em `windows-discord-install.ts`, o helper só aceita o executável direto `<flavour>.exe`/minúsculo ou uma pasta `app-*` imediata. Já `discordProcessState()` usa `tasklist` apenas pelo nome da imagem e não obtém `ExecutablePath`. Assim, um cliente instalado em `Program Files`, em outro volume ou em uma pasta portátil não registrada fica invisível quando suas raízes fixas não existem; mesmo em execução, `tasklist` não fornece o caminho que permitiria recuperar a instalação.

## Objetivos

1. Ampliar somente a descoberta Windows para instalações conhecidas fora de `%LOCALAPPDATA%`.
2. Detectar uma instalação em execução pelo caminho real do processo.
3. Detectar uma instalação parada por registro e atalhos conhecidos, sem varrer o disco inteiro.
4. Manter o contrato atual de `WindowsDiscordInstall` e fornecer sempre `exePath` absoluto, validado e terminado no executável do flavour.
5. Preservar todos os consumidores atuais: ativação WireSock, status, início, restauração, rollback e failover.
6. Manter o isolamento por aplicativo existente, sem ler, gravar, renomear ou assumir `app.asar`.
7. Tornar falhas de uma fonte observáveis sem transformar uma falha parcial em prova de que o Discord não está instalado.

## Fora do escopo

- Alterar `windowsAllowedAppPaths()` ou o contrato de `AllowedApps`. A descoberta fornece o `exePath` exato; a inclusão atual de diretório, subprocessos e updater continua sendo comportamento de isolamento já adotado e não faz parte da issue #300.
- Remover ou redesenhar a expansão atual de `AllowedApps`.
- Alterar macOS, Linux, plugin Vencord/Equicord, standalone, proxy/PAC/Tor ou injeção.
- Alterar o conteúdo de `app.asar`, `_app.asar` ou qualquer mecanismo de modificação do cliente.
- Fazer inventário recursivo de volumes, busca por nome em todo o disco ou reparo automático de instalações.
- Escrever registro, criar atalhos, instalar cliente, elevar permissões para ler ou reparar ACLs.
- Adicionar inventário completo de MSIX/AppX nesta primeira versão.
- Exigir validação Authenticode ou introduzir uma dependência externa para ler registro, processos ou atalhos.

## Arquitetura: pipeline Windows bounded

`getWinDiscordInstalls()` continuará sendo a porta de entrada síncrona usada pela GUI. Internamente, a descoberta será um pipeline de handlers independentes, todos limitados a fontes conhecidas:

1. **Raízes fixas atuais e raízes conhecidas de Program Files**: preserva as raízes sob `%LOCALAPPDATA%` e adiciona somente combinações estáticas sob `%ProgramFiles%`, `%ProgramFiles(x86)%` e `%ProgramW6432%` quando este último existir e for diferente dos demais:
   `%ProgramFiles%\<flavour>`, `%ProgramFiles%\Programs\<flavour>`, `%ProgramFiles(x86)%\<flavour>`, `%ProgramFiles(x86)%\Programs\<flavour>`, `%ProgramW6432%\<flavour>` e `%ProgramW6432%\Programs\<flavour>`.
   Cada diretório é consultado diretamente. O handler chama o finder existente, que só examina o executável direto e subpastas `app-*` imediatas.
2. **Processo em execução**: uma coleta PowerShell única consulta `Win32_Process` somente para os seis nomes de imagem allowlistados e devolve `ExecutablePath`. O handler transforma caminhos válidos em instalações mesmo quando nenhum root conhecido existe.
3. **Registro**: a mesma coleta PowerShell lê `App Paths`, URL handlers e entradas relevantes de `Uninstall` em `HKCU`, `HKLM` e a visão `WOW6432Node`. O valor DEFAULT de `App Paths`/URL handler, `DisplayIcon` e `InstallLocation` são apenas indícios; cada caminho passa pelo mesmo validador e, quando é uma raiz, pelo finder bounded.
As chaves de URL handlers são constantes: `HKCU\Software\Classes\<scheme>\shell\open\command`, `HKLM\Software\Classes\<scheme>\shell\open\command` e, quando aplicável, a visão `WOW6432Node`, para cada esquema `discord`, `discordptb`, `discordcanary`, `vesktop`, `equibop` e `legcord`. Não são aceitos esquemas ou subárvores descobertos dinamicamente.
4. **Handlers/adapters**: cada fonte tem um adapter separado que converte sua saída para um candidato comum (`root`, `process`, `registry` ou `shortcut`), sem fazer spawn, iniciar cliente ou modificar o sistema. O parser do JSON PowerShell é independente do adapter de atalhos; filesystem e resolução de atalho são dependências injetáveis.
5. **Atalhos conhecidos**: `shell.readShortcutLink()` é um adapter separado, não parte do stdout PowerShell. Ele usa exatamente quatro raízes: `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, `%ProgramData%\Microsoft\Windows\Start Menu\Programs`, `%USERPROFILE%\Desktop` e `%PUBLIC%\Desktop`. Em cada raiz de Start Menu são permitidos links diretos (`dir\*.lnk`) e exatamente um subnível vendor (`dir\*\*.lnk`); não há segundo subnível nem recursão. A enumeração é filtrada por flavour e limitada a no máximo 64 links por raiz e 64 por subdiretório vendor.
6. **Validação, deduplicação e retorno**: os handlers entregam candidatos; o pipeline valida, deduplica, registra metadados de origem e devolve a mesma forma consumida por `main.ts`.

Os argumentos de atalhos são lidos somente em memória para decidir o candidato; nunca são executados, persistidos ou registrados no log. A chamada continua sob `withNoAsar()`, usando `original-fs` (`diskFs`) para tratar caminhos reais do Windows. `resources` será derivado como a pasta `resources` ao lado de `exePath`; sua existência não é requisito de descoberta e nenhum `app.asar` é consultado.

## Contrato do coletor PowerShell — `schema=1`

O coletor será executado com `execFileSync("powershell.exe", ...)`, argumentos fixos, `-NoProfile`, `-NonInteractive`, `windowsHide=true` e timeout máximo de três segundos. O script não interpolará caminhos, argumentos ou conteúdo fornecido pelo usuário. A lista de nomes e os caminhos de registro serão constantes do aplicativo; `-EncodedCommand` é preferível quando o script for montado como string para evitar problemas de quoting.

A saída stdout será JSON compacto no formato:

```json
{
  "schema": 1,
  "process": {
    "status": "ok",
    "rows": [
      {
        "name": "Discord.exe",
        "pid": 1234,
        "path": "C:\\Program Files\\Discord\\app-1.0.0\\Discord.exe"
      }
    ],
    "truncated": false
  },
  "registry": {
    "status": "partial",
    "rows": [
      {
        "hive": "hkcu",
        "kind": "app-paths",
        "value": "\"C:\\Program Files\\Discord\\Discord.exe\"",
        "flavourHint": "Discord"
      },
      {
        "hive": "hklm",
        "kind": "uninstall",
        "value": "",
        "flavourHint": "Discord",
        "displayIcon": "C:\\Program Files\\Discord\\Update.exe,0",
        "installLocation": "C:\\Program Files\\Discord"
      }
    ],
    "truncated": true,
    "errorCode": "UNINSTALL_LIMIT"
  }
}
```

Os campos são definidos assim:

- `schema` é inteiro e deve ser exatamente `1`; versões desconhecidas são rejeitadas.
- Cada bloco tem `status`: `ok`, `empty`, `partial` ou `error`, e `truncated: boolean`. `empty` é uma resposta normal, inclusive quando nenhum processo está executando. `partial` é obrigatório quando um teto de coleta é atingido; `error` representa falha daquele bloco.
- `process.rows` contém somente `name`, `pid` e `path`. `CommandLine`, argumentos e stdout/stderr de processos nunca são coletados nem retornados.
- `registry.rows` contém `hive`, `kind`, `value` e, quando aplicável, `flavourHint`, `displayIcon` e `installLocation`. `kind` é exatamente um de `app-paths`, `uninstall` ou `url-handler`.
- Para `app-paths` e `url-handler`, `value` é o valor DEFAULT da chave. O parser extrai dele somente o primeiro token que pareça um executável, sem aceitar nem remover marcador `,0`; a validade final exige basename allowlistado. Para `uninstall`, `value` também representa o DEFAULT da subchave e `displayIcon`/`installLocation` permanecem disponíveis. Somente o token extraído de `displayIcon` aceita e remove o sufixo final `,0`; o valor original não recebe essa normalização. O coletor não envia uma propriedade `Path` separada.
- `flavourHint` de `app-paths` e `url-handler` só pode ser derivado do mapeamento constante de nomes de executável, chaves e esquemas URL acima. Em `uninstall`, ele só pode ser derivado de `DisplayName` allowlistado ou de um caminho cujo flavour seja inequívoco; texto arbitrário não escolhe flavour.
- `errorCode` é um código estável por bloco, como `CIM_UNAVAILABLE`, `REGISTRY_UNAVAILABLE`, `UNINSTALL_LIMIT`, `TIMEOUT` ou `JSON_SERIALIZATION_FAILED`; exceções e mensagens com caminhos não saem do coletor.
- As listas são forçadas com `@(...)`, pois o PowerShell 5.1 serializa uma lista de um elemento como objeto. O parser TypeScript normaliza a forma resultante para array antes da validação.
- O limite de processo é 64 rows. O limite de `Uninstall` é 128 subchaves por hive/root consultado; o bloco marca `partial` e `truncated=true` ao atingir o teto. A ordem de enumeração do registro não é garantida, portanto o corte pode ocorrer antes de uma entrada Discord. `Uninstall` é somente indício/fallback e nunca fonte única: App Paths, URL handlers, atalhos e processo continuam sendo consultados. Os limites de App Paths e URL handlers também são fixos e pequenos. O restante do pipeline continua.

O bloco de processo usa um filtro CIM limitado aos nomes literais `Discord.exe`, `DiscordPTB.exe`, `DiscordCanary.exe`, `Vesktop.exe`, `Equibop.exe` e `Legcord.exe`, seguido de `Select-Object Name,ProcessId,ExecutablePath`. O bloco de registro consulta App Paths e os URL handlers constantes e percorre somente até 128 subchaves por cada root `Uninstall` de `HKCU`, `HKLM` e `WOW6432Node`, filtrando por `DisplayName` allowlistado e por campos que apontem para os flavours. Ler essas três visões é uma consulta de registro bounded, não um filtro de rede nem uma inspeção irrestrita da máquina. Um erro em um bloco não impede a produção do outro.

O código de saída também é parte do contrato: JSON válido, inclusive vazio ou parcial, sai com código `0`. Código diferente de zero fica reservado para falha catastrófica (PowerShell indisponível, falha de serialização ou impossibilidade de produzir JSON) e é mapeado para `errorCode`; ausência de linhas nunca usa código de erro.

O parser extrai executáveis sem executar comandos. Para `value` de App Paths/URL handler, lê apenas o primeiro token (com aspas externas removidas quando delimitam esse token) e não remove `,0` nem qualquer outro marcador. Para `displayIcon`, remove aspas externas e somente o sufixo final `,0` do token extraído. Para URL handler, o primeiro token pode ser `Update.exe` somente quando os tokens seguintes contiverem exatamente `--processStart <flavour>.exe`; nesse caso o parser deriva a raiz do updater e chama o finder bounded. Para `InstallLocation`, o parser passa a raiz diretamente ao finder. Os argumentos permanecem em memória e nunca são executados. Todos os caminhos resultantes passam pelo validador comum.

## Validação, flavour, dedupe e precedência

O parser TypeScript e o normalizador de caminho aplicarão as mesmas regras a processo, registro, raiz e atalho:

1. Remover espaços externos; remover aspas externas somente quando delimitam o token de caminho. O sufixo final `,0` só pode ser removido do token extraído de `displayIcon`, nunca de `value` de App Paths/URL handler.
2. Rejeitar NUL, controles, quebras de linha, aspas internas, vírgulas restantes, argumentos, `UNC`, caminho de dispositivo e Alternate Data Streams.
3. Exigir caminho absoluto com letra de drive e extensão `.exe`.
4. Canonicalizar separadores/case para comparação, verificar `existsSync` e `statSync().isFile()` e, quando disponível, resolver `realpath` antes da deduplicação.
5. Derivar o flavour exclusivamente do basename, comparado case-insensitively com a allowlist. `flavourHint` do registro pode orientar a busca de uma raiz, mas não substitui o basename e, se divergir de um executável direto, o candidato é rejeitado.
6. `Update.exe` não é um candidato Discord. Quando registro ou atalho apontar para ele, o handler só poderá extrair uma raiz bounded e procurar o `<flavour>.exe` direto ou em `app-*` imediato. Argumentos nunca são executados.
7. Para processo, aceitar o caminho somente quando o executável existir, tiver basename allowlistado e cumprir **parent `app-*`** (por exemplo, `D:\MyDiscord\app-1.0.10\Discord.exe`) **ou for executável direto com `resources` ao lado**. Não é necessário que um ancestral tenha o nome do flavour.
8. Para uma instalação válida, `appDir=dirname(exePath)`, `resources=join(appDir, "resources")` e `exePath` permanecem absolutos. A validade não depende de `app.asar`.

A precedência para o mesmo `exePath` canonicalizado é:

1. processo em execução;
2. raízes fixas, incluindo as raízes conhecidas de Program Files;
3. registro;
4. atalhos.

Somente o mesmo executável é deduplicado. Roots distintos do mesmo flavour e executáveis distintos do mesmo flavour são preservados. Sem uma UI nova de escolha, a semântica atual permanece: todos os installs retornados são iniciados pelos consumidores. `detectedBy` é metadado interno do pipeline e do diagnóstico; ele é removido ao construir o `DiscordInstall` público, cujo contrato não muda.

## Cache, timeout e falhas parciais

A API pública permanece síncrona porque `getWinDiscordInstalls()` é chamada por ativação, status, restauração, failover e diagnóstico. O TTL único do snapshot de descoberta é **exatamente quatro segundos**. Um snapshot pode ficar stale por no máximo **oito segundos**, mas somente `getStatus()` e o diagnóstico do watchdog (`startWindowsRouteWatchdog()` → `diagnoseWindowsRoute()`) podem usar stale; nenhum lifecycle (ativação, desativação, restauração, troca de rota ou rollback) pode usar stale. Uma chamada PowerShell no máximo ocorrerá por TTL; não haverá retry síncrono no mesmo scan.

A chave do cache inclui plataforma e todos os roots/env que influenciam a descoberta: `LOCALAPPDATA`, `APPDATA`, `USERPROFILE`, `PUBLIC`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)` e `ProgramW6432`. Qualquer mudança de valor, inclusive `ProgramW6432` passar a ser igual/diferente de outro root, invalida o snapshot. As transições que precisam de uma lista confiável pedem `forceRefresh`, sempre antes de ativação, desativação, `restore-internet`, troca manual de rota, otimização/troca Proton, failover e cada rollback.

As raízes fixas e validações de arquivos são bounded e executadas diretamente. O coletor PowerShell usa `execFileSync` síncrono e pode bloquear a thread principal por no máximo três segundos por chamada; o cache garante no máximo uma chamada por TTL. Não há busca aberta nem execução em background. Atalhos são limitados a um nível direto ou exatamente um subnível vendor e a no máximo 64 links por raiz e 64 por subdiretório vendor; um shortcut malformado é ignorado individualmente.

Falhas são tratadas assim:

- `status=empty` e código `0` com zero rows são respostas normais.
- Falha de CIM, falta de permissão ou `ExecutablePath=null` não vira candidato e não é registrada como processo parado.
- Timeout, código não-zero, JSON inválido ou bloco `error` preserva candidatos das outras fontes. Código não-zero é mapeado para `errorCode` estável e não para “nenhuma instalação”.
- Um snapshot stale (até oito segundos) só pode ser usado por `getStatus()` e pelo diagnóstico do watchdog em `startWindowsRouteWatchdog()` → `diagnoseWindowsRoute()`. Todo lifecycle — ativação, desativação, `restore-internet`, troca manual/Proton, failover e rollback — exige `forceRefresh` e não pode usar stale, inclusive para montar perfil, AllowedApps, spawn ou restart.
- Uma fonte que retorna zero não apaga instalações retornadas por outra.
- Se o resultado final for zero, mantém-se `scan.resultado total=0`, `ativacao.sem_discord` e a mensagem atual `Nenhum Discord encontrado.`. O diagnóstico adicional informa se as fontes estavam vazias ou indisponíveis, sem transformar erro parcial em ausência comprovada.


## Integração com os consumidores atuais

### Ativação e início

`executarAtivacao()` captura o snapshot com refresh antes de `killDiscord()`. O snapshot é o conjunto de instalações que será usado para montar o perfil, iniciar o WireSock e chamar `startDiscordAndConfirm()`. O início continua sendo `spawn(install.exePath, [], ...)`, com listener de erro e confirmação existente; não há execução de strings vindas de registro ou atalhos.

A revalidação de `existsSync/stat` imediatamente antes do spawn cobre a corrida com updater, antivírus ou remoção manual. Uma falha de spawn segue o rollback existente. A descoberta não modifica o momento em que o túnel é criado nem transforma diagnóstico de rota em requisito de ativação.

### Status e processo

`getStatus()` consome o snapshot cacheado. `NOT_FOUND` continua significando ausência de candidato válido, enquanto `ACTIVE` continua exigindo `windowsRouteStarted`, WireSock ativo e `discordIsRunning()`. A consulta de instalação por `ExecutablePath` não substitui a semântica de liveness atual de `tasklist`; falha de uma consulta de caminho não pode fazer `waitUntilDiscordRunning()` aceitar ou rejeitar uma transição como se o processo estivesse parado.

### Desativação, restauração e rollbacks

Qualquer fluxo que possa matar o cliente deve pedir `forceRefresh`, capturar e reter o snapshot fresco antes de `killDiscord()`:

- `deactivateAll()` deve pedir refresh, capturar `installs` antes do kill e reutilizar essa lista após restaurar a rede.
- `restore-internet` deve pedir refresh, capturar `installs` antes do kill quando `hadWireSock` for verdadeiro e reutilizar a lista no `startDiscordAndConfirm()`. Não pode chamar descoberta baseada em processo somente depois de matar o processo.
- A troca manual/otimização Proton deve pedir refresh antes de matar o cliente. `applyProtonRouteResult()` deve reutilizar no rollback a variável capturada antes da troca, em vez de fazer um segundo scan depois de `killDiscord()`.
- `applyProtonFailoverCandidate()` deve pedir refresh antes de qualquer troca que possa encerrar o cliente e manter o snapshot capturado antes da mudança de rota; os caminhos de falha/rollback não podem perder um cliente encontrado apenas pelo processo.
- Cada rollback de ativação, restauração ou troca de rota deve usar um snapshot fresco capturado antes do kill correspondente; nunca pode usar o snapshot stale de status/watchdog.
- O caminho de startup que chama ativação herda a captura anterior ao kill; nenhuma persistência de caminho process-only em settings é necessária.

A lista pode conter `resources` derivado inexistente ou não gravável. `discord-scope-proof` e o espelhamento de logs continuam best-effort e log-only; falhar ao copiar um probe em `Program Files` não deve impedir WireSock, spawn ou rollback. O marker de sessão continua sendo usado como hoje e não autoriza alterações no cliente.

### AllowedApps

O contrato de `windowsAllowedAppPaths()`/`AllowedApps` permanece inalterado nesta issue. A única obrigação da nova descoberta é que cada `install.exePath` entregue ao consumidor seja um caminho absoluto, validado, existente no momento da coleta e terminado no executável exato do flavour. A função atual pode continuar acrescentando diretório da instalação, subprocessos conhecidos e updater conforme o isolamento por aplicativo já adotado. Não haverá remoção desses itens, nem inclusão de `app.asar`.

## Logs sanitizados

`discordscan.ts` deve registrar a origem e o resultado sem despejar entradas cruas:

- permitido: `source`, `status`, `flavour`, `detected_by`, contagem, `truncated` e códigos estáveis de erro;
- proibido: `CommandLine`, argumentos de atalhos, stdout/stderr do PowerShell, chaves de registro completas, PID desnecessário e `ExecutablePath` bruto;
- `scan.raiz` e `scan.install` existentes devem receber caminho já sanitizado ou um identificador de categoria/hash antes de chamar `logger.info`, pois não usam diretamente o pipeline de `logger.logEvent` com redaction por chave;
- se essa sanitização alterar o formato ou o conteúdo observável de `scan.raiz`/`scan.install`, registrar a mudança no `CHANGELOG.md` junto com a implementação;
- se um caminho for necessário para diagnóstico, substituir o diretório de perfil por `<usuario>`, remover componentes customizados e limitar o valor; preferir um hash curto não reversível operacionalmente;

A redação de `bugreport.ts` continua como segunda barreira, mas não é a primeira linha de proteção. Nenhum dado do registro, shortcut ou processo deve chegar ao log para depender dessa segunda etapa.

## Testes permanentes e smoke Windows

1. raízes diretas de Program Files e `app-*` imediato, sem exigir `app.asar`;
2. processo externo com `ExecutablePath` válido para cada flavour;
3. processo com path nulo, basename falso, caminho relativo, UNC, ADS ou arquivo ausente;
4. parser `schema=1` com array de zero/um item, JSON inválido, erro de bloco e resposta truncada;
5. registro App Paths/URL handler/Uninstall com `value` DEFAULT, `DisplayIcon` entre aspas e `,0`, `InstallLocation`, `DisplayName` allowlistado, `Update.exe` stale e valores malformados;
6. atalhos target direto, target `Update.exe` com `--processStart` allowlistado, argumentos apenas em memória e links quebrados;
7. deduplicação case-insensitive e precedência processo > raiz > registro > atalho, preservando roots distintos do mesmo flavour;
8. limite de enumeração e ausência de `readdir` recursivo/varredura de volume;
9. cache com TTL exatamente 4s, stale máximo 8s somente em status/watchdog, forceRefresh obrigatório em lifecycle e invalidação por todos os roots/env, incluindo `ProgramW6432`;
10. snapshot capturado antes de `killDiscord()` e reutilizado em restore/rollback;
11. logs sem caminho bruto, command line, args de atalho ou stdout do coletor;
12. teste de integração do builder: o `exePath` absoluto produzido pelo discovery deve chegar sem alteração à entrada de `windowsAllowedAppPaths()` (e continuar sendo parte do resultado expandido atual), sem alterar o contrato de `AllowedApps`.

O smoke test Windows deve usar uma VM/disposição descartável e cobrir: instalação real fora de `%LOCALAPPDATA%` em Program Files sem processo executando; mesma instalação aberta e descoberta por `ExecutablePath`; ativação WireSock e confirmação de `AllowedApps` conforme o contrato existente; desativação/restore; troca de rota com rollback; e uma instalação sem registro/atalho que só seja reconhecida enquanto está em execução. O smoke não deve pesquisar volumes nem modificar registro/atalhos do sistema fora da operação já testada.

## Compatibilidade e limitações

- Electron 43, Node e TypeScript atuais permanecem suportados; não é necessária dependência nova.
- Windows PowerShell 5.1 é o alvo do coletor; nomes de propriedades JSON não dependem do idioma da interface.
- `%LOCALAPPDATA%` continua sendo lido quando presente, mas sua ausência não bloqueia processo, registro ou atalhos.
- O comportamento de `AllowedApps` não muda; Linux, macOS, plugin e standalone ficam intocados.
- Uma instalação MSIX/AppX pode estar sob `WindowsApps`, ter ACL restritiva ou não expor `App Paths`. Nesta versão ela só será detectada se processo, registro consultado ou atalho conhecido fornecerem um executável exato que passe pelo validador; não haverá chamada adicional a inventário AppX nem elevação para inspecionar o pacote.
- Uma instalação portátil sem registro e sem atalho conhecido só é detectável enquanto seu processo estiver executando. Cold-start desse caso requer que o usuário tenha uma fonte conhecida; o produto não fará busca arbitrária.
- Layouts vendor-nested ou volumes remotos fora das combinações fixas dependem de registro, atalho ou processo. UNC e caminhos de dispositivo são rejeitados por segurança.
- ACL que impede `stat`, `realpath` ou cópia do probe não autoriza fallback inseguro: o candidato é descartado ou o diagnóstico é marcado como indisponível.

O aceite de #300 exige que uma instalação externa sem processo seja encontrada por registro/atalho conhecido, que uma instalação externa em execução seja encontrada pelo `ExecutablePath`, que falhas de uma fonte não destruam resultados de outras, que nenhum scan recursivo ocorra e que restore/rollback não percam a lista capturada antes de `killDiscord()`.
