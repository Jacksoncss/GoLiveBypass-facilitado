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

1. **Raízes fixas atuais e raízes conhecidas de Program Files**: preserva as raízes sob `%LOCALAPPDATA%` e adiciona somente combinações estáticas sob `%ProgramFiles%` e `%ProgramFiles(x86)%`:
   `%ProgramFiles%\<flavour>`, `%ProgramFiles%\Programs\<flavour>`, `%ProgramFiles(x86)%\<flavour>` e `%ProgramFiles(x86)%\Programs\<flavour>`.
   Cada diretório é consultado diretamente. O handler chama o finder existente, que só examina o executável direto e subpastas `app-*` imediatas.
2. **Processo em execução**: uma coleta PowerShell única consulta `Win32_Process` somente para os seis nomes de imagem allowlistados e devolve `ExecutablePath`. O handler transforma caminhos válidos em instalações mesmo quando nenhum root conhecido existe.
3. **Registro**: a mesma coleta PowerShell lê `App Paths` e entradas relevantes de `Uninstall` em `HKCU`, `HKLM` e a visão `WOW6432Node`. `DisplayIcon` e `InstallLocation` são apenas indícios; cada caminho passa pelo mesmo validador e, quando é uma raiz, pelo finder bounded.
4. **Handlers/adapters**: cada fonte tem um adapter separado que converte sua saída para um candidato comum (`root`, `process`, `registry` ou `shortcut`), sem fazer spawn, iniciar cliente ou modificar o sistema. O parser PowerShell é puro em relação à decisão de validade; filesystem e resolução de atalho são dependências injetáveis.
5. **Atalhos conhecidos**: `shell.readShortcutLink()` é usado somente em diretórios de atalhos do usuário e comuns: Start Menu do usuário, Start Menu comum, Desktop do usuário e Public Desktop. A enumeração é de um nível, limitada e filtrada por nomes dos flavours. Não há busca recursiva.
6. **Validação, deduplicação e retorno**: os handlers entregam candidatos; o pipeline valida, deduplica, registra metadados de origem e devolve a mesma forma consumida por `main.ts`.

A chamada continua sob `withNoAsar()`, usando `original-fs` (`diskFs`) para tratar caminhos reais do Windows. `resources` será derivado como a pasta `resources` ao lado de `exePath`; sua existência não é requisito de descoberta e nenhum `app.asar` é consultado.

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
    ]
  },
  "registry": {
    "status": "partial",
    "rows": [
      {
        "hive": "hkcu",
        "kind": "app-paths",
        "flavourHint": "Discord",
        "displayIcon": "C:\\Program Files\\Discord\\Update.exe,0",
        "installLocation": "C:\\Program Files\\Discord"
      }
    ],
    "truncated": false
  }
}
```

Os campos são definidos assim:

- `schema` é inteiro e deve ser exatamente `1`; versões desconhecidas são rejeitadas.
- Cada bloco tem `status`: `ok`, `empty`, `partial` ou `error`. `empty` é uma resposta normal, inclusive quando nenhum processo está executando.
- `process.rows` contém somente `name`, `pid` e `path`. `CommandLine`, argumentos e stdout/stderr de processos nunca são coletados nem retornados.
- `registry.rows` contém apenas `hive`, `kind`, `flavourHint`, `displayIcon` e `installLocation`. O coletor pode ler propriedades cruas para formar a resposta, mas elas ficam em memória e não vão para o logger.
- `errorCode` é um código estável, como `CIM_UNAVAILABLE`, `REGISTRY_UNAVAILABLE`, `TIMEOUT` ou `JSON_SERIALIZATION_FAILED`; exceções e mensagens com caminhos não saem do coletor.
- As listas são forçadas com `@(...)`, pois o PowerShell 5.1 serializa uma lista de um elemento como objeto. O parser TypeScript aceita a forma resultante somente depois de normalizá-la para array.
- Há limite de registros (por exemplo, 64 candidatos por bloco). Se o limite for alcançado, o bloco vira `partial` e marca `truncated=true`; o restante do pipeline continua.

O bloco de processo usa um filtro CIM limitado aos nomes literais `Discord.exe`, `DiscordPTB.exe`, `DiscordCanary.exe`, `Vesktop.exe`, `Equibop.exe` e `Legcord.exe`, seguido de `Select-Object Name,ProcessId,ExecutablePath`. O bloco de registro consulta `App Paths` para esses seis executáveis e percorre somente os subitens dos três roots `Uninstall` conhecidos, filtrando propriedades por marca ou caminho de flavour. Um erro em um bloco não impede a produção do outro.

## Validação, flavour, dedupe e precedência

O parser TypeScript e o normalizador de caminho aplicarão as mesmas regras a processo, registro, raiz e atalho:

1. Remover espaços externos, aspas externas e, somente em `DisplayIcon`, o sufixo final `,0`.
2. Rejeitar NUL, controles, quebras de linha, aspas internas, vírgulas restantes, argumentos, `UNC`, caminho de dispositivo e Alternate Data Streams.
3. Exigir caminho absoluto com letra de drive e extensão `.exe`.
4. Canonicalizar separadores/case para comparação, verificar `existsSync` e `statSync().isFile()` e, quando disponível, resolver `realpath` antes da deduplicação.
5. Derivar o flavour exclusivamente do basename, comparado case-insensitively com a allowlist. `flavourHint` do registro pode orientar a busca de uma raiz, mas não substitui o basename e, se divergir de um executável direto, o candidato é rejeitado.
6. `Update.exe` não é um candidato Discord. Quando registro ou atalho apontar para ele, o handler só poderá extrair uma raiz bounded e procurar o `<flavour>.exe` direto ou em `app-*` imediato.
7. Para processo, aceitar o caminho somente quando o executável existir e tiver layout conhecido: `app-<versão>` abaixo de uma pasta do flavour ou executável direto em pasta do flavour com `resources`. Isso reduz falsos positivos de processos homônimos sem introduzir assinatura binária.
8. Para uma instalação válida, `appDir=dirname(exePath)`, `resources=join(appDir, "resources")` e `exePath` permanecem absolutos. A validade não depende de `app.asar`.

A precedência para o mesmo `exePath` canonicalizado é:

1. processo em execução;
2. raízes fixas, incluindo as raízes conhecidas de Program Files;
3. registro;
4. atalhos.

Somente o mesmo executável é deduplicado. Instalações distintas, inclusive clientes/flavours distintos ou duas raízes distintas, continuam retornando como hoje para que os consumidores iniciem todos os clientes descobertos. A origem de maior precedência fica em `detectedBy` apenas para diagnóstico; ela não altera o contrato funcional do candidato.

## Cache, timeout e falhas parciais

A API pública permanece síncrona porque `getWinDiscordInstalls()` é chamada por ativação, status, restauração, failover e diagnóstico. O snapshot de descoberta terá cache curto de três a cinco segundos para `getStatus()` e watchdogs. Uma chamada PowerShell no máximo ocorrerá por TTL; não haverá retry síncrono no mesmo scan. A alteração de `LOCALAPPDATA`, `ProgramFiles` ou `ProgramFiles(x86)` invalida o snapshot. As transições que precisam de uma lista confiável pedirão `forceRefresh` antes de começar.

As raízes fixas e validações de arquivos são bounded e executadas diretamente. O coletor PowerShell tem timeout de três segundos. Atalhos são limitados a um nível e, por diretório, a no máximo 64 links filtrados; um shortcut malformado é ignorado individualmente. O pipeline não paralisa a GUI esperando uma busca aberta.

Falhas são tratadas assim:

- `status=empty` ou exit code que significa “nenhuma linha” é uma resposta normal.
- Falha de CIM, falta de permissão ou `ExecutablePath=null` não vira candidato e não é registrada como processo parado.
- Timeout, erro de execução, JSON inválido ou bloco `error` preserva candidatos das outras fontes.
- Um snapshot externo válido ainda dentro da janela de stale pode ser reutilizado quando a consulta nova falhar; candidatos são sempre revalidados antes de spawn.
- Uma fonte que retorna zero não apaga instalações retornadas por outra fonte.
- Se o resultado final for zero, mantém-se `scan.resultado total=0`, `ativacao.sem_discord` e a mensagem atual `Nenhum Discord encontrado.`. O diagnóstico adicional informa se as fontes estavam vazias ou indisponíveis, sem transformar erro parcial em ausência comprovada.

## Integração com os consumidores atuais

### Ativação e início

`executarAtivacao()` captura o snapshot com refresh antes de `killDiscord()`. O snapshot é o conjunto de instalações que será usado para montar o perfil, iniciar o WireSock e chamar `startDiscordAndConfirm()`. O início continua sendo `spawn(install.exePath, [], ...)`, com listener de erro e confirmação existente; não há execução de strings vindas de registro ou atalhos.

A revalidação de `existsSync/stat` imediatamente antes do spawn cobre a corrida com updater, antivírus ou remoção manual. Uma falha de spawn segue o rollback existente. A descoberta não modifica o momento em que o túnel é criado nem transforma diagnóstico de rota em requisito de ativação.

### Status e processo

`getStatus()` consome o snapshot cacheado. `NOT_FOUND` continua significando ausência de candidato válido, enquanto `ACTIVE` continua exigindo `windowsRouteStarted`, WireSock ativo e `discordIsRunning()`. A consulta de instalação por `ExecutablePath` não substitui a semântica de liveness atual de `tasklist`; falha de uma consulta de caminho não pode fazer `waitUntilDiscordRunning()` aceitar ou rejeitar uma transição como se o processo estivesse parado.

### Desativação, restauração e rollbacks

Qualquer fluxo que possa matar o cliente deve capturar e reter o snapshot antes de `killDiscord()`:

- `deactivateAll()` já captura `installs` antes do kill e reutiliza essa lista após restaurar a rede.
- `restore-internet` deve capturar `installs` antes do kill quando `hadWireSock` for verdadeiro e reutilizar a lista no `startDiscordAndConfirm()`. Não pode chamar descoberta baseada em processo somente depois de matar o processo.
- `applyProtonRouteResult()` deve reutilizar no rollback a variável capturada antes da troca, em vez de fazer um segundo scan depois de `killDiscord()`.
- `applyProtonFailoverCandidate()` deve manter o snapshot capturado antes da mudança de rota; os caminhos de falha não podem perder um cliente encontrado apenas pelo processo.
- O caminho de startup que chama ativação herda a captura anterior ao kill; nenhuma persistência de caminho process-only em settings é necessária.

A lista pode conter `resources` derivado inexistente ou não gravável. `discord-scope-proof` e o espelhamento de logs continuam best-effort e log-only; falhar ao copiar um probe em `Program Files` não deve impedir WireSock, spawn ou rollback. O marker de sessão continua sendo usado como hoje e não autoriza alterações no cliente.

### AllowedApps

O contrato de `windowsAllowedAppPaths()`/`AllowedApps` permanece inalterado nesta issue. A única obrigação da nova descoberta é que cada `install.exePath` entregue ao consumidor seja um caminho absoluto, validado, existente no momento da coleta e terminado no executável exato do flavour. A função atual pode continuar acrescentando diretório da instalação, subprocessos conhecidos e updater conforme o isolamento por aplicativo já adotado. Não haverá remoção desses itens, nem inclusão de `app.asar`.

## Logs sanitizados

`discordscan.ts` deve registrar a origem e o resultado sem despejar entradas cruas:

- permitido: `source`, `status`, `flavour`, `detected_by`, contagem, `truncated` e códigos estáveis de erro;
- proibido: `CommandLine`, argumentos de atalhos, stdout/stderr do PowerShell, chaves de registro completas, PID desnecessário e `ExecutablePath` bruto;
- `scan.raiz` e `scan.install` existentes devem receber caminho já sanitizado ou um identificador de categoria/hash antes de chamar `logger.info`, pois não usam diretamente o pipeline de `logger.logEvent` com redaction por chave;
- se um caminho for necessário para diagnóstico, substituir o diretório de perfil por `<usuario>`, remover componentes customizados e limitar o valor; preferir um hash curto não reversível operacionalmente;
- mensagens de erro devem usar `errorCode` e `clipLogText` depois de remover caminhos, nunca a exceção completa.

A redação de `bugreport.ts` continua como segunda barreira, mas não é a primeira linha de proteção. Nenhum dado do registro, shortcut ou processo deve chegar ao log para depender dessa segunda etapa.

## Testes permanentes e smoke Windows

A implementação deverá manter os testes atuais de `windows-discord-install.test.ts` e acrescentar comportamento observável para:

1. raízes diretas de Program Files e `app-*` imediato, sem exigir `app.asar`;
2. processo externo com `ExecutablePath` válido para cada flavour;
3. processo com path nulo, basename falso, caminho relativo, UNC, ADS ou arquivo ausente;
4. parser `schema=1` com array de zero/um item, JSON inválido, erro de bloco e resposta truncada;
5. registro App Paths/Uninstall com `DisplayIcon` entre aspas e `,0`, `InstallLocation`, `Update.exe` stale e valores malformados;
6. atalhos target direto, target `Update.exe` com `--processStart` allowlistado e links quebrados;
7. deduplicação case-insensitive e precedência processo > raiz > registro > atalho, preservando instalações distintas;
8. limite de enumeração e ausência de `readdir` recursivo/varredura de volume;
9. cache, refresh, timeout e preservação de candidatos em falha parcial;
10. snapshot capturado antes de `killDiscord()` e reutilizado em restore/rollback;
11. logs sem caminho bruto, command line, args de atalho ou stdout do coletor.

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
