# Canal de atualização dos instaladores do plugin

## Escopo aprovado

Os instaladores Windows e Linux do plugin GoLiveBypass permitem escolher `stable` ou `beta` para a instalação inicial e para atualizações. Windows expõe `-Channel stable|beta`; Linux expõe `--channel stable|beta`. Sem flag, o padrão é `stable`. Em uma execução interativa sem flag, o instalador apresenta stable como opção recomendada e beta como opt-in de testes. Em `-Yes`/`--yes`, não há prompt: prevalece a preferência persistida válida ou stable.

## Precedência e persistência

A ordem é: flag explícita, seleção interativa, preferência persistida e, por último, stable. A preferência fica somente em `plugins.GoLiveBypass.updateChannel` no `settings.json` do Equicord/Vencord. O merge preserva `autoUpdate` e todas as outras chaves; JSON inválido não é sobrescrito. As configurações da GUI, standalone e outros componentes não participam desse estado. A preferência só é persistida após uma seleção/operação válida. `--PluginSource`/`--plugin-source` continua sendo fonte local explícita.

## Seleção e contratos de release

A API usa a coleção de releases, nunca `/releases/latest` no fluxo beta. Candidatas precisam ser não-draft, ter tag SemVer válida e metadata de prerelease coerente, além de `goLiveBypass-vencord.zip` e `goLiveBypass-vencord.zip.sha256` com URLs HTTPS. Stable aceita somente releases estáveis. Beta aceita stable e prerelease. A seleção escolhe a maior versão SemVer válida, tratando `beta-9 < beta-10 < beta-11`, e só atualiza quando a candidata é estritamente maior que a versão local.

A instalação/atualização usa o ZIP e o SHA da mesma release e valida o manifest extraído antes de substituir o plugin. Ausência de ZIP/SHA, versão ou metadata inconsistente, erro de API/timeout, hash divergente ou manifest incompatível falha explicitamente e preserva a instalação. Não há downgrade nem fallback silencioso para `RepoRaw`; uma fonte local só é usada por opção explícita ou pelo checkout local já selecionado pelo instalador.

## Mensagens e segurança

As mensagens explicam que stable é o canal mais previsível e recebe somente releases estáveis. Beta é um canal de testes em que a pessoa ajuda a comunidade ao testar, encontrar e corrigir erros antes da versão estável. O texto é encorajador e honesto: nenhum canal promete estabilidade. `--check-update` consulta e informa o canal/candidata sem baixar o ZIP, mas pode persistir a preferência selecionada após uma operação válida; nenhuma falha do updater altera GUI, WireGuard, roteamento, standalone ou o funcionamento do plugin.
