# Plugin WireSock: retomada automática de instâncias GoLiveBypass

## Objetivo

Eliminar o bloqueio de ativação do plugin no Windows quando o slot global do WireSock está ocupado por uma instância comprovadamente iniciada pelo próprio GoLiveBypass. O clique em **Ativar** deve encerrar essa instância, assumir o slot e concluir a ativação sem exigir que o usuário descubra ou finalize serviços manualmente.

A retomada não autoriza encerrar uma VPN WireSock externa. Estado desconhecido continua falhando de forma segura.

## Escopo

- Plugin Vencord/Equicord no Windows x64.
- Serviços `wiresock-client-service` e `wiresock-pro-client-service`.
- Processos `wiresock-client.exe` executados pelo plugin ou pela GUI GoLiveBypass.
- Ativação explicitamente solicitada pelo usuário.
- Mensagens, logs e testes do fluxo alterado.

Fora de escopo:

- Retomada automática no boot, autostart ou watchdog.
- Encerramento de WireSock cuja origem não seja comprovada.
- Mudança do transporte Linux ou do standalone.
- Protocolo de handoff ou owner compartilhado entre GUI e plugin.
- Alteração da GUI Electron.

## Estado atual e causa

GUI e plugin compartilham os nomes globais de serviço do WireSock, mas aplicam configs diferentes:

- GUI: `%LOCALAPPDATA%\GoLiveBypass\wiresock-discord.conf`.
- Plugin: `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn\wiresock-discord.conf`.

`inspectWireSock` já lê, em um único snapshot, o `PathName` e `ProcessId` dos serviços e a `CommandLine` dos processos. Porém, seu resultado reduz todas as configurações diferentes da config do plugin a `owned: false`. Por isso uma sessão da GUI recebe a mesma classificação de uma VPN WireSock externa e a ativação termina em `blocked_external`.

Em algumas corridas, a falha entra no rollback e produz a mensagem composta “A ativação falhou e a rede não foi restaurada”, embora o conflito já existisse antes e não pertencesse à tentativa atual.

## Classificação de propriedade

A inspeção continuará sendo uma leitura única do SCM/CIM, mas classificará cada serviço e processo ativo em uma destas origens:

- `plugin`: linha de comando contém o caminho exato normalizado da config aplicada pelo plugin.
- `golivebypass_gui`: linha de comando contém o caminho exato normalizado da config aplicada pela GUI em `guiDataDir`.
- `external`: linha de comando é legível, mas não contém nenhuma config gerenciada conhecida.
- `unknown`: o estado, `PathName`, `CommandLine` ou vínculo serviço/PID não permite uma conclusão confiável.

A comparação deve ser por argumento de config normalizado, não por substring de diretório. Caminhos como `wiresock-discord.conf.bak` não podem ser aceitos como propriedade.

Um PID com `CommandLine` ausente só pode herdar a origem do serviço quando coincide com o `ProcessId` de um serviço cuja config foi classificada. Fora desse vínculo, sua origem é `unknown`.

A inspeção agregada deve expor:

- recursos ativos e respectivos PIDs/serviços;
- `reliable`;
- se todos os conflitos são gerenciados pelo GoLiveBypass;
- se existe qualquer recurso externo ou desconhecido;
- motivo público sanitizado.

## Fluxo de ativação explícita

`PluginVpnController.startInternal(true)` seguirá esta ordem no Windows:

1. Inspecionar o WireSock com as configs conhecidas do plugin e da GUI.
2. Se a leitura não for confiável, retornar `recovery_required` sem encerrar nada.
3. Se houver recurso `external` ou mistura de gerenciado com externo, retornar `blocked_external` sem encerrar nada.
4. Se já existir somente a sessão do plugin, adotar o túnel como hoje.
5. Se existirem apenas recursos `golivebypass_gui`, adquirir o owner do plugin e executar a retomada gerenciada.
6. Encerrar apenas os serviços e PIDs classificados como GoLiveBypass, aguardar ausência confiável e então iniciar o serviço com a config do plugin.
7. Confirmar que todos os serviços e processos ativos pertencem ao plugin antes de marcar o estado como `active` ou `restart_pending`.

A retomada pode repetir uma vez se um recurso GoLiveBypass reaparecer entre o preflight e a instalação do serviço. Não haverá loop nem retomada periódica.

A ativação automática continuará usando o comportamento conservador existente. Encontrar a GUI durante boot/autostart não concede autorização implícita para interrompê-la.

## Limpeza gerenciada

Será criada uma operação Windows específica para a retomada. Ela recebe o snapshot classificado e as configs gerenciadas, em vez de procurar processos novamente por nome.

Regras:

- parar somente serviços cuja origem seja `plugin` ou `golivebypass_gui`;
- encerrar somente os PIDs classificados no snapshot;
- usar `taskkill /PID`, nunca `/IM wiresock-client.exe`;
- revalidar ownership antes de cada kill após espera ou elevação;
- interromper imediatamente se aparecer recurso externo ou desconhecido;
- aguardar estados transitórios com o limite já usado pela inspeção;
- tentar `reset-network-lock` e limpeza de DNS somente depois de provar que todos os recursos encerrados eram GoLiveBypass;
- considerar sucesso apenas quando uma inspeção confiável confirmar ausência total de serviço e processo WireSock.

Recusa de UAC, timeout ou resíduo gerenciado deixam o plugin inativo e retornam erro específico. Eles não devem afirmar que uma rede externa foi modificada ou que a restauração falhou.

## Corridas e ownership do plugin

O `owner.lock` atual continua protegendo duas instâncias do plugin. A retomada da GUI acontece somente depois de o plugin adquirir esse owner; assim, uma segunda instância viva não pode usar a classificação da GUI para derrubar a primeira.

A GUI não participa do mutex. Portanto, se ela tentar reativar durante a retomada, a segunda inspeção decidirá:

- reapareceu apenas uma config GoLiveBypass: um único retry permitido;
- apareceu recurso externo ou desconhecido: abortar sem kill;
- plugin confirmou sua própria config: concluir normalmente.

O campo `started` do controller só representa serviço confirmado pela tentativa atual. Conflito pré-existente ou retomada que falhou antes do start não entra no rollback de túnel próprio.

## Estados e mensagens

- GUI retomada com sucesso: log informativo “WireSock da GUI GoLiveBypass encerrado; plugin assumiu o serviço”. A UI segue para ativo, sem toast de erro.
- GUI detectada durante boot/autostart: `blocked_external` com mensagem curta informando que outra superfície GoLiveBypass está ativa; nenhum kill.
- WireSock externo comprovado: `blocked_external`, preservado.
- Estado ilegível/transitório após as retentativas: `recovery_required`, preservado.
- UAC recusado: estado inativo e mensagem “O Windows não autorizou encerrar a instância anterior do GoLiveBypass.”
- Resíduo gerenciado após timeout: estado inativo e mensagem “A instância anterior do GoLiveBypass não encerrou; tente novamente.”

Detalhes de serviço, PID e origem ficam somente nos logs sanitizados.

## Testes

Testes permanentes devem observar comportamento, não texto-fonte:

1. Classificação da config exata do plugin como `plugin`.
2. Classificação da config exata da GUI como `golivebypass_gui`.
3. Config com sufixo, caminho externo e mistura gerenciado/externo permanecem protegidos.
4. PID sem command line só herda origem do serviço pelo `ProcessId` correspondente.
5. Ativação explícita com GUI ativa: para apenas recursos gerenciados, revalida, inicia o plugin e conclui.
6. Ativação automática com GUI ativa: não chama limpeza nem kill.
7. Recurso externo ou desconhecido: nenhum comando destrutivo é executado.
8. Corrida com GUI reaparecendo: exatamente um retry.
9. Falha anterior ao start não produz o erro de rollback “rede não foi restaurada”.

Testes de fonte que prendem a guarda antiga `active && !owned` devem ser removidos ou substituídos por testes sobre a inspeção e o controller reais.

## Verificação Windows

Na VM:

1. iniciar a GUI com seu `wiresock-discord.conf` ativo;
2. confirmar pelo snapshot que serviço/processo apontam para a config da GUI;
3. no Discord oficial com plugin atualizado, clicar **Ativar**;
4. aceitar o UAC quando solicitado;
5. confirmar que o recurso anterior foi encerrado e que o serviço ativo aponta para `plugin-vpn\wiresock-discord.conf`;
6. confirmar estado “VPN Ativa”, Discord logado e HTTPS do Discord pelo túnel;
7. repetir com uma config WireSock fora de `%LOCALAPPDATA%\GoLiveBypass` e confirmar que ela permanece ativa e o plugin bloqueia sem matar.

## Documentação

Registrar no `CHANGELOG.md` que a retomada automática se limita a instâncias comprovadas do GoLiveBypass e ocorre somente após ativação explícita. Documentar que WireSock externo e leituras inconclusivas continuam preservados.