# Canal de atualização no menu TUI dos instaladores

## Objetivo e escopo

Adicionar um item dedicado no menu principal dos instaladores Windows e Linux para mudar o canal do plugin sem instalar, atualizar, recompilar, injetar ou reiniciar o Discord. O item abre um submenu com `Stable` e `Beta`, grava a escolha imediatamente e retorna ao menu principal. A escolha não altera o canal da GUI, do standalone ou de outro componente.


## Retorno ao menu e ausência de checkout

Embora o menu principal atual execute uma ação e encerre a execução, `Mudar canal de atualizacoes` é uma exceção deliberada: depois de salvar ou cancelar, a função retorna ao laço/menu principal para que a pessoa escolha outra ação ou saia. O retorno não reinstala o instalador nem repete a seleção de alvos.

Sem checkout válido, a opção continua visível, mas não deve criar clone, escolher Equicord/Vencord por inferência nem escrever configuração em um caminho ambíguo. O submenu informa que a preferência persistente exige um checkout identificado. Se a pessoa iniciar a instalação, o instalador prepara/seleciona o mod e então pergunta o canal no fluxo normal; cancelar a mudança de canal sem checkout não grava nada.

Com checkout válido, a tela mostra o canal atual (ou `Stable` quando não houver preferência válida) e oferece `Stable`, `Beta` e `Cancelar`. Apenas Stable/Beta confirmados persistem imediatamente; Cancelar retorna ao menu sem alterar o arquivo.

## Abordagens consideradas

1. **Reutilizar o fluxo de instalação/atualização:** simples, mas causaria efeitos colaterais (download, build ou injeção) ao apenas trocar uma preferência.
2. **Adicionar um item que altera diretamente o JSON com lógica duplicada em cada instalador:** separa corretamente os efeitos, porém aumenta o risco de divergência no merge e no tratamento de JSON inválido.
3. **Reutilizar as funções existentes de localização, leitura/merge e seleção de canal, adicionando apenas um comando de menu e um submenu:** mantém o contrato atual de settings, reduz duplicação e garante que a mudança de canal seja uma operação isolada.

A decisão é a abordagem 3. O submenu chama uma operação própria de persistência; não chama `Install-PluginSource`, `install_plugin_source`, `Invoke-Update`, `do_update`, build ou injeção.

## Fluxo Linux

No menu principal TUI, incluir `Mudar canal de atualizacoes` como item separado dos itens de instalar, verificar, atualizar, remover e restaurar. Ao confirmar, abrir submenu:

- `Stable (recomendado)` — canal mais previsível, somente releases estáveis.
- `Beta (opt-in)` — canal de testes; a pessoa ajuda a comunidade a testar, encontrar e corrigir erros antes da versão estável. Nenhum canal promete estabilidade.

O submenu deve aceitar voltar/cancelar sem gravar nada. Em uma escolha válida, localizar o `settings.json` do mod selecionado usando `mod_settings_file`, fazer merge de `plugins.GoLiveBypass.updateChannel` e voltar ao menu principal exibindo o canal salvo. Não executar download ou consulta de release.

## Fluxo Windows

No menu principal TUI, incluir o mesmo item dedicado. O submenu usa a convenção de seleção existente e apresenta os mesmos textos. Em escolha válida, usar `Get-ModSettingsFile` e a rotina de merge própria do instalador para atualizar somente `plugins.GoLiveBypass.updateChannel`; depois informar sucesso e retornar ao menu. Não executar instalação, atualização, build, injeção ou reinício.

Se não houver TUI ANSI, o menu textual existente deve oferecer o item equivalente e o submenu textual. A escolha vazia, `Esc`, opção fora da lista ou erro de entrada cancela a operação e retorna ao menu sem escrever.

## Persistência, precedência e flags

A preferência permanece somente em `plugins.GoLiveBypass.updateChannel` no `settings.json` do Equicord/Vencord. O merge preserva `autoUpdate`, outros plugins e todas as demais chaves. JSON ausente pode ser criado; JSON inválido ou estrutura ilegível não deve ser sobrescrita nem truncada, e o erro deve ser mostrado de forma acionável.

A precedência já aprovada permanece: `-Channel`/`--channel` explícito vence qualquer preferência persistida; sem flag, a ação de mudar canal permite escolher no submenu; em `-Yes`/`--yes`, não abrir submenu nem bloquear: usar a preferência persistida válida ou `stable` como default. O item de menu não deve contradizer uma flag explícita: se o canal foi fixado por flag, informar o canal efetivo e não gravar uma escolha diferente sem uma ação explícita compatível. A mudança pelo item do menu grava imediatamente, independentemente de executar instalação ou update depois.

## Cancelamento e erros

Cancelar não altera settings e retorna ao menu principal. Falha ao localizar o mod/settings, criar diretório ou salvar deve manter o conteúdo anterior quando possível, informar o motivo e oferecer retorno ao menu; não deve disparar download, fallback `RepoRaw`, build ou alteração de rede. A confirmação de sucesso só aparece depois de reler e confirmar `updateChannel` como `stable` ou `beta`.

## Regressões e validação

Adicionar testes comportamentais nos harnesses existentes para:

- item dedicado presente nos menus Windows/Linux e submenu com stable/beta;
- seleção stable/beta persistida imediatamente e retorno sem chamar download/update/build/injeção;
- cancelamento preserva o JSON;
- merge preserva `autoUpdate` e chaves desconhecidas;
- JSON inválido permanece intacto;
- `-Channel`/`--channel` explícito continua vencendo a preferência;
- `-Yes`/`--yes` não bloqueia e usa preferência válida ou stable;
- mensagens recomendam stable e descrevem beta de forma positiva e honesta.

Validação mínima: `sh -n`/`bash -n`, harness shell de auto-update/persistência/log, `tests/test-auto-update.ps1` em PowerShell/VM quando disponível, `node tests/test-distribution-parity.cjs`, `node tests/test-plugin-update-channel.mjs`, `node tests/test-plugin-update-audit.mjs` e `git diff --check`. Não fazer release, tag, push ou merge como parte desta mudança de especificação.
