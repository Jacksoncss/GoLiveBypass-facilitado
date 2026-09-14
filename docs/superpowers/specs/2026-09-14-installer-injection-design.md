# Injeção verificável do instalador PowerShell

## Contexto

O instalador PowerShell chama `pnpm run inject` para cada cliente oficial selecionado. A chamada atual passa um separador `--` extra, descarta a saída estruturada do processo com `Out-Host`, decide principalmente pelo exit code e não comprova que o `resources` daquele alvo passou a apontar para o checkout escolhido. Isso permite falso sucesso quando uma versão de pnpm interpreta argumentos de forma diferente, quando o injector retorna código impreciso ou quando lança uma exceção.

## Objetivos

- Remover o `--` extra da chamada `pnpm run inject --location <raiz>`.
- Capturar saída e exceções do injector com limite estrito e sem despejar texto arbitrário no relato.
- Considerar sucesso somente quando cada alvo oficial selecionado aponta para o checkout escolhido após a chamada.
- Preservar o comportamento de clientes paralelos, seleção de alvos, build e restauração existente.
- Manter mensagens por alvo úteis para diagnóstico e seguras para relatórios automáticos.

## Fora do escopo

- Alterar o instalador shell, GUI, plugin, release, changelog ou rede.
- Mudar como `pnpm`, Node ou dependências são instalados.
- Reescrever a descoberta de checkouts ou clientes.
- Declarar sucesso por exit code sem verificar o estado do alvo.

## Fluxo

Para cada alvo oficial, o instalador calcula a raiz de instalação a partir de `resources` e executa `Invoke-Pnpm @('run', 'inject', '--location', $loc)`. A invocação fica em `try/catch`; a saída é coletada em vez de emitida diretamente, normalizada em uma única linha e limitada antes de ser anexada ao diagnóstico daquele alvo.

Após a execução, o instalador sempre chama a verificação existente de injeção para aquele `resources`: o stub deve resolver para um caminho sob o checkout selecionado. Exit code zero sem a pós-condição é falha. Exit code não zero com a pós-condição verdadeira é sucesso observável, com aviso diagnóstico limitado, porque o estado de instalação é a autoridade.

Uma exceção do wrapper também é registrada como detalhe limitado e não interrompe a verificação de outros alvos. Quando qualquer alvo oficial não satisfaz a pós-condição, a operação termina com a mensagem agregada já existente, incluindo somente flavour, categoria e saída/erro limitado.

## Segurança e preservação

- Não há fallback que injete sem alvo explícito.
- O instalador não troca, remove nem desinstala arquivos ao receber somente um exit code estranho.
- A pós-condição é por alvo selecionado, não uma busca global que possa aprovar outro Discord já injetado.
- Caminhos e saída ficam limitados; nenhum segredo é produzido pelo fluxo.

## Testes e verificação

Testes PowerShell seguros isolam `Invoke-Pnpm`, `Get-InjectedPath` e os alvos em diretórios temporários. Eles devem comprovar:

1. a chamada oficial não contém o `--` extra;
2. saída longa e exceção viram detalhe limitado;
3. código zero sem stub apontando para o checkout falha;
4. código não zero com stub apontando para o checkout passa a pós-condição;
5. dois alvos têm resultado independente e um alvo não aprova o outro.

Executar, em Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tests/test-error-handling.ps1
```

## Critérios de aceite

- `run inject` recebe somente os argumentos necessários para `--location`.
- Exceções e saída são capturadas e limitadas.
- O estado injetado de cada alvo oficial define sucesso.
- Falha em um alvo preserva os demais resultados e produz diagnóstico limitado.
- Nenhum teste usa Discord real, credenciais, rede ou publicação.
