# Rotas Proton sempre visíveis e erros de login no plugin

## Contexto

O plugin Vencord/Equicord oferece somente a otimização automática Proton. Quando o helper testa candidatas e não aprova nenhuma, o onboarding e o painel exibem uma falha sem permitir que o usuário escolha uma rota específica. A GUI já possui os contratos de catálogo, ping, recomendação, seleção manual, preflight e promoção atômica que devem orientar o porte, mas seu código de renderer não pode ser reutilizado diretamente porque o plugin usa React e uma ponte nativa própria.

O login do plugin também pode apresentar “Usuário ou senha incorretos” para falhas que não são de credencial. `proton-confgen` envolve qualquer erro de autenticação com o prefixo `authentication failed`, e a classificação textual do plugin trata esse prefixo genérico como `INVALID_CREDENTIALS`. Códigos estruturados do helper precisam ter precedência, e falhas de execução do helper precisam de classificação própria.

## Objetivos

- Manter a seleção manual de rota sempre visível no onboarding e no painel Proton.
- Mostrar catálogo e ping progressivamente, com uma rota recomendada.
- Preservar a otimização automática como ação primária e impedir operações concorrentes.
- Validar integralmente uma rota manual antes de substituir ou aplicar o perfil.
- Preservar perfil, túnel e restauração anteriores quando a seleção falhar.
- Distinguir credenciais rejeitadas de falha do helper, rede, timeout, armazenamento, 2FA e CAPTCHA.
- Compartilhar apresentação e regras entre onboarding e painel, sem duplicar a lógica de domínio.

## Fora do escopo

- Alterar o algoritmo, os limites ou os filtros da otimização automática.
- Alterar o pool de failover Proton.
- Aplicar uma rota recomendada sem confirmação do usuário.
- Persistir o catálogo entre contas ou reinicializações do Discord.
- Gerar antecipadamente um perfil para cada rota do catálogo.
- Alterar o standalone, a GUI, proxy, PAC, Tor ou injeção de `app.asar`.
- Tratar ping ou probes de saída como condição global de ativação.

## Decisões de produto

### Lista sempre visível

A seção “Escolha uma rota Proton” permanece visível sempre que existir uma sessão Proton válida, tanto na etapa de rota do onboarding quanto no painel de configurações. Ela não depende de falha ou cancelamento da otimização automática.

Ao entrar na superfície, o plugin inicia uma descoberta para a conta e os filtros atuais. O contêiner aparece imediatamente; durante a descoberta, entradas catalogadas podem aparecer com estado “Medindo ping”. O ping é preenchido progressivamente. Uma rota sem ping válido permanece desabilitada, não recebe recomendação e não pode ser aplicada.

O botão “Otimizar automaticamente” fica acima da lista. Durante descoberta exclusiva, otimização ou aplicação manual, os dados já recebidos continuam visíveis, mas ações incompatíveis ficam desabilitadas. Isso evita duas mutações simultâneas do perfil sem esconder contexto do usuário.

### Ordenação e recomendação

Rotas selecionáveis são ordenadas por ping crescente, com nome normalizado como desempate estável. Rotas ainda sem ping ou com falha aparecem depois das rotas selecionáveis.

A recomendação nunca implica aplicação automática:

1. se houver download e upload válidos de uma medição completa, usa a capacidade harmônica dessas métricas e desempata por ping;
2. caso contrário, recomenda a rota selecionável de menor ping;
3. uma rota com ping inválido ou preflight explicitamente reprovado nunca recebe o selo `Recomendada`.

### Falha da otimização

Se a otimização automática terminar com zero rotas aprovadas, o erro fica junto da ação automática e a lista manual continua disponível. Candidatas já medidas são mescladas ao catálogo sem perder ping, velocidade ou estado. Uma falha automática não apaga alternativas e não substitui o perfil anterior.

## Arquitetura

### Modelo compartilhado do plugin

A lógica pura de candidatos ficará separada dos componentes React. O modelo conterá:

- nome exato do servidor;
- país, cidade, tier, carga e score públicos;
- ping, download e upload opcionais;
- estados independentes de ping, preflight e velocidade;
- motivo de falha sanitizado;
- predicados derivados de selecionabilidade e recomendação.

Eventos das fases `catalog`, `ping`, `preparing` e `testing` atualizam a mesma candidata, indexada pelo nome exato do servidor. Ordenação, recomendação e redução de eventos seguem o comportamento já comprovado em `golive-gui/src/proton-manual-selection.ts`, adaptado ao plugin sem importar código da GUI.

### Descoberta no wrapper Proton

`goLiveBypass/vpn-proton.ts` ganhará uma operação de catálogo que executa o helper com `-route-catalog -auto-ping -progress-json -json`, sessão autenticada e filtros atuais. O parser aceitará explicitamente a fase `catalog` e validará todos os metadados públicos e o ping opcional.
O helper deve emitir cada entrada de catálogo assim que ela for conhecida e
atualizar a mesma entrada quando a medição de ping terminar. Não basta medir
todas as candidatas silenciosamente e despejar os eventos apenas no fim: o
contrato aprovado exige preenchimento progressivo da lista.

A descoberta:

- não solicita certificado;
- não cria chave ou perfil;
- não abre túnel;
- não altera a rota selecionada;
- não expõe endpoint, sessão, token, chave ou conteúdo de configuração ao renderer.

Falhas individuais de ping não derrubam o catálogo inteiro. Apenas valores finitos, positivos e menores que `999 ms` são válidos.

### Sessão efêmera de medição

O processo nativo mantém uma sessão de descoberta com:

- `measurementId` imprevisível;
- conta Proton normalizada;
- país, plano e filtros usados;
- conjunto exato de servidores catalogados;
- estado de cada candidata;
- geração, owner e prazo de expiração.

Logout, troca de conta, alteração de filtro, nova descoberta ou expiração invalidam a sessão anterior. Eventos e seleções com identificador antigo são ignorados ou rejeitados. O renderer envia somente `measurementId` e nome exato do servidor.

### Ponte nativa

A superfície nativa acrescentará três operações:

- `discoverProtonRoutes`: inicia catálogo e ping progressivos e retorna `measurementId` e rotas públicas;
- `cancelProtonRouteDiscovery`: cancela apenas a descoberta correspondente;
- `selectProtonRoute`: valida a sessão e tenta aplicar o servidor exato.

O progresso será entregue pelo canal nativo existente ou por canal específico com `requestId`/`measurementId`. O estado consultável pelo renderer deve continuar coerente depois de remount do componente.

### Seleção e aplicação manual

A seleção manual usa o helper com servidor exato e `-manual-probe`. Antes de promover o perfil, o backend confirma:

1. owner, geração e validade da sessão de medição;
2. identidade da conta e filtros atuais;
3. servidor online e elegível para país, plano e exclusões;
4. peer WireGuard utilizável;
5. ping atual válido;
6. preflight WireGuard e HTTPS;
7. configuração gerada em arquivo de staging.

Somente após essas validações o perfil de staging substitui atomicamente o perfil Proton. Ping isolado não prova que a rota funciona.

Se o plugin estiver inativo, a rota é preparada para a próxima ativação. Se estiver ativo, o controlador reutiliza o ciclo atual de pausa, restauração e relançamento. No Windows, a rota anterior é restaurada se a troca falhar. No Linux, o fluxo respeita a impossibilidade de devolver o processo atual ao namespace original e usa o relançamento já existente. Probes posteriores de IP/HTTP permanecem apenas diagnósticos em log.

### Componentes React

Um componente compartilhado renderiza a seção no onboarding e no painel. Ele recebe estado derivado e callbacks, sem chamar diretamente o helper. A interface contém:

- ação “Otimizar automaticamente”;
- estado e erro da otimização próximos à ação;
- lista de altura limitada e rolável;
- país/cidade, servidor, tier/carga quando úteis e ping;
- selo `Recomendada`;
- estado “Medindo ping”, “Indisponível” ou motivo sanitizado;
- ação para selecionar cada rota válida;
- estado “Aplicando rota <servidor>”.

Erros usam região anunciada (`role="alert"` ou `aria-live`). A lista e as ações são navegáveis por teclado. Re-renderizações não recriam estruturas estáticas desnecessariamente.

## Login Proton

### Contrato de erro

Os códigos estruturados retornados pelo helper têm precedência absoluta sobre heurísticas textuais. A expressão genérica `authentication failed` deixa de classificar credenciais como inválidas.

O contrato acrescenta `HELPER_ERROR`, reservado para:

- falha ao iniciar o processo após o executável ter sido localizado;
- encerramento inesperado sem resposta JSON estruturada utilizável;
- resposta inválida ou incompatível com o contrato de login.

Uma rejeição estruturada do Proton nunca vira `HELPER_ERROR`. `UNKNOWN` continua representando uma rejeição ou falha Proton não reconhecida que chegou por um caminho executado normalmente.

A ponte de CAPTCHA preserva `CAPTCHA_INVALID` e `CAPTCHA_CANCELLED`; não converte ambas em cancelamento. Detalhes técnicos permanecem nos logs sanitizados.

### Mensagens

| Código | Mensagem principal |
| --- | --- |
| `INVALID_CREDENTIALS` | Usuário ou senha incorretos. Confira os dados e tente novamente. |
| `TWO_FACTOR_REQUIRED` | Esta conta exige o código 2FA. |
| `TWO_FACTOR_INVALID` | O código 2FA está incorreto ou expirou. |
| `CAPTCHA_REQUIRED` | O Proton solicitou uma verificação de segurança. |
| `CAPTCHA_INVALID` | A verificação expirou ou foi recusada. Tente novamente. |
| `CAPTCHA_CANCELLED` | A verificação Proton foi cancelada. |
| `NETWORK_ERROR` | Não foi possível conectar aos servidores ProtonVPN. Verifique a rede e tente novamente. |
| `TIMEOUT` | O ProtonVPN demorou demais para responder. Tente novamente. |
| `MISSING_EXECUTABLE` | O componente ProtonVPN não foi encontrado no pacote do plugin. Reinstale ou atualize o plugin. |
| `SESSION_PERSISTENCE` | O login foi processado, mas o plugin não conseguiu acessar o armazenamento seguro da sessão. |
| `HELPER_ERROR` | O componente ProtonVPN falhou antes de concluir o login. Reinicie o Discord e tente novamente. |
| `CONFIGURATION_ERROR` | Mensagem específica sobre o campo ausente ou estado incompatível. |
| `UNKNOWN` | O Proton recusou ou não concluiu o login por um motivo não reconhecido. |

Uma função compartilhada converte o resultado em apresentação para onboarding e painel. O erro aparece próximo aos campos, não somente em toast. `INVALID_CREDENTIALS` devolve foco ao campo de senha. Uma falha da verificação de sessão anterior ao login usa texto neutro e nunca acusa senha incorreta.

## Estados e falhas

- **Sem sessão válida:** lista de rotas não consulta o catálogo; login orienta a recuperação.
- **Descobrindo:** lista visível, progresso anunciado e seleção desabilitada.
- **Descoberta parcial:** entradas recebidas permanecem visíveis e pings válidos habilitam seleção quando não houver operação exclusiva.
- **Catálogo vazio:** mensagem explícita; otimização pode ser tentada novamente.
- **Falha de catálogo:** candidatas anteriores válidas podem permanecer visíveis se ainda pertencerem à mesma sessão e filtros; há ação de nova descoberta.
- **Otimização em andamento:** lista continua visível, porém não permite seleção.
- **Otimização sem aprovadas:** erro automático não elimina a escolha manual.
- **Aplicação manual:** todas as ações concorrentes ficam bloqueadas.
- **Falha manual:** linha recebe erro sanitizado e perfil anterior permanece.
- **Resposta obsoleta:** geração e owner impedem atualização da interface ou aplicação.
- **Logout/troca de conta:** catálogo, medição e seleção pendente são cancelados e apagados.

## Testes e verificação

### Lógica TypeScript

- reduzir eventos de catálogo, ping, preflight e velocidade na mesma candidata;
- ordenar rotas por ping e nome de modo estável;
- recomendar por capacidade quando houver velocidade e por menor ping nos demais casos;
- nunca recomendar nem habilitar rota sem ping válido ou com preflight reprovado;
- preservar candidatas ao falhar a otimização automática;
- ignorar eventos de geração antiga.

### Wrapper e controlador

- catálogo usa `-route-catalog -auto-ping -progress-json` sem gerar perfil;
- parser aceita `catalog` e rejeita métricas inválidas;
- descoberta não altera perfil nem rota ativa;
- seleção rejeita `measurementId`, conta ou filtros obsoletos;
- seleção usa servidor exato, ping novo, peer e preflight;
- promoção ocorre somente a partir de staging válido;
- falha preserva perfil e restaura rota anterior quando aplicável;
- descoberta, otimização, ativação e seleção não executam simultaneamente.

### Login

- `authentication failed: protocol error` não vira `INVALID_CREDENTIALS`;
- rejeição estruturada `INVALID_CREDENTIALS` mantém mensagem de credencial;
- falha de spawn, encerramento inesperado e JSON inválido viram `HELPER_ERROR`;
- rede, timeout, armazenamento, 2FA e CAPTCHA preservam códigos específicos;
- CAPTCHA inválido não vira cancelamento;
- onboarding e painel apresentam a mesma mensagem por código.

### Interface e smoke test

- lista permanece renderizada antes, durante e depois da otimização;
- carregamento, recomendação, ping, desabilitação e erro são visíveis e acessíveis;
- seleção manual exercita a ponte nativa e atualiza o estado final;
- build real do plugin é carregado no Discord e as duas superfícies são exercitadas;
- na plataforma afetada, validar que somente o Discord usa o túnel, que a rota selecionada alcança HTTPS e que a restauração devolve a rede anterior.

Testes unitários não comprovam WFP, namespace, rota real ou saída geográfica. Ausência de validação Windows/Linux real deve ser declarada antes de release.

## Critérios de aceite

- A seleção manual está sempre visível com sessão Proton válida no onboarding e no painel.
- A lista mostra catálogo e ping progressivamente e identifica uma recomendação sem aplicá-la automaticamente.
- Rotas sem ping válido ou com preflight reprovado não podem ser aplicadas.
- A otimização automática continua disponível e não concorre com a seleção manual.
- Uma otimização com zero rotas aprovadas mantém alternativas manuais acessíveis.
- A escolha manual só promove um perfil após revalidação completa e staging.
- Falha manual preserva ou restaura a configuração anterior.
- `INVALID_CREDENTIALS` é exibido somente quando a credencial foi explicitamente rejeitada.
- Falha de execução ou contrato do helper é exibida como `HELPER_ERROR`, com orientação própria.
- Onboarding e painel compartilham mensagens e comportamento.
- Nenhum segredo chega ao renderer, às mensagens ou aos logs.
- Isolamento por aplicativo e probes diagnósticos permanecem inalterados.
