# macOS 0.8.0: "Usar no celular" (iPhone e Android pelo app WireGuard)

> **Revisão de 2026-10-21:** a pedido do usuário, a escolha iPhone | Android saiu. Existe uma conf só, a do iPhone (split por IP, sem `DNS`), que funciona igual no WireGuard dos dois sistemas. O nome do dispositivo passou a ser `GoLiveBypass-Celular`. O Android perde o isolamento por app (`IncludedApplications`) e fica como o iPhone e o Mac. Validado no Android real: QR importado, live com câmera.

## Objetivo

Levar o bypass do Go Live para iPhone e Android **sem app próprio no celular**. O
GoLiveBypass do Mac gera uma conf WireGuard só para o celular, com a sessão Proton
que já está salva, e entrega essa conf ao **app oficial do WireGuard**, gratuito na
App Store e na Play Store. Depois de importada, a conf roda sozinha no celular: o Mac
não precisa estar ligado.

## Por que não um app nativo

- **iPhone:** um app de VPN precisa da NetworkExtension. Ela só existe com a conta
  paga da Apple, e a App Store ainda exige conta de organização para VPN. Com Apple ID
  grátis, TrollStore, jailbreak ou certificado corporativo, o app não chega a quem usa.
- **Android:** é viável (`VpnService` + APK), mas seria um app novo do zero: login
  Proton, geração da conf e túnel.
- **O app WireGuard já resolve o túnel nos dois sistemas.** Falta só entregar a
  conf certa, e isso o Mac já sabe gerar.

## Fatos verificados no código

- `proton-confgen` gera **um par de chaves novo a cada geração** (`ed25519.NewKeyPair`
  → `ToX25519Base64`). O Proton exige a chave **ed25519**
  (`internal/vpn/client.go`, `ClientPublicKey` em PEM). Uma chave X25519 criada no app
  WireGuard do celular não pode ser registrada, então a chave privada **sempre nasce
  no Mac**.
- **Conf persistente** (padrão, sem `-no-save`):
  - aparece no painel do Proton VPN com o nome de `-device-name` e pode ser revogada lá;
  - dura até 365 dias (`DefaultCertDuration = "365d"`);
  - o JSON da geração devolve `expiresAt` (Unix, segundos), mas **não** devolve o serial.
- `-renew-serial` e `-list-configs` só têm saída em texto. Por isso a renovação sem
  escanear de novo fica **fora** desta versão (ver Fora do escopo).
- O Mac já valida o servidor com uma chave nova por `-manual-probe` (túnel netstack,
  sem tocar nas rotas do Mac).
- A conf Free sem `-ipv6` não tem endereço IPv6. Ranges IPv6 colocados nos `AllowedIPs`
  viram buraco negro: o tráfego não sai, e o app cai para o IPv4 tunelado. É o mesmo
  efeito das rejeições IPv6 que o helper aplica no Mac.
- O WireGuard Android aceita `IncludedApplications` no `[Interface]`, então a conf já
  chega restrita ao Discord.
- O app do Mac **não tem dependência de runtime** hoje. `qrcode-generator@1.4.4` é MIT,
  sem dependências e com tipos (`qrcode.d.ts`).

## Comportamento

### Onde fica

Um ícone novo no topo da janela, "Usar no celular", ao lado de Como funciona,
Checar atualizações e Configurações. Ele abre um painel no mesmo estilo dos outros.

O painel só gera conf no **modo Proton com conta salva**. Sem isso, ele mostra
"Entre na sua conta Proton em Proton Otimizado para gerar a conf do celular." e
nenhum botão de gerar.

### Escolhas do painel

1. **Aparelho:** controle segmentado **iPhone | Android**.
2. **Como entregar:** **QR code** (padrão) | **Arquivo (sem câmera)**.
3. Botão **Gerar conf para o celular**.

### Geração (igual para os dois modos de entrega)

1. Roda o catálogo com ping (`-route-catalog -auto-ping`) e escolhe o menor ping
   (`pickLowestPing`).
2. Gera com `-server <escolhido> -manual-probe -device-name <nome> -output <temporário>`.
   - `<nome>` é `GoLiveBypass-iPhone` ou `GoLiveBypass-Android`.
   - O `-manual-probe` prova que **a chave nova** passa tráfego antes de entregar.
   - Sem senha: usa a sessão salva.
3. Transforma a conf bruta com `buildPhoneConf` (abaixo) e apaga o temporário do disco
   na hora, aconteça o que acontecer.
4. A conf final fica **só na memória do processo principal**, até o painel fechar ou
   uma nova geração substituí-la. **Nunca** vai para `golive.conf`, para o log, para
   as configurações nem para o renderer como texto.
5. **Não muda nada do Mac:** `golive.conf`, `connectionMode`, `protonServer` e o túnel
   ativo ficam como estavam.
6. Grava nas configurações só os metadados, em `phoneConf`:
   `{ platform, server, country, city, expiresAt, generatedAt }`.

### Conteúdo da conf (`buildPhoneConf`)

| | iPhone (`ios`) | Android (`android`) |
|---|---|---|
| `[Interface]` | `PrivateKey`, `Address`, `MTU` (se houver) | idem + `DNS` da conf Proton + `IncludedApplications = com.discord` |
| `DNS` | **removido** (o iPhone mantém o DNS dele) | **mantido** (só o Discord usa o túnel e precisa resolver por ele) |
| `[Peer]` | `PublicKey`, `Endpoint`, `PersistentKeepalive = 25` | idem |
| `AllowedIPs` | `162.159.0.0/16, 104.16.0.0/12, 2606:4700::/32, 2a06:98c0::/29` | `0.0.0.0/0, ::/0` |
| Isolamento | por IP, igual ao Mac | por app, igual à GUI Windows |

Regras:
- Chaves fora dessa lista (`PostUp`, `PreDown`, `Table` etc.) saem.
- Falta `PrivateKey`, `Address`, `PublicKey` ou `Endpoint` → erro `invalid_conf`, e
  nada é entregue.
- Os ranges vêm das constantes existentes `DISCORD_ALLOWED_IPS` e `DISCORD_REJECT_V6`.

### Entrega A: QR code

- O main gera um SVG com `qrcode-generator` (nível de correção `M`) e envia ao
  renderer como `data:image/svg+xml;base64,…`. O renderer exibe num `<img>`, sem
  `innerHTML`.
- Acima do QR, um aviso fixo: "Este QR code contém a chave privada da conf. Não tire
  print nem mostre para ninguém. Se ele vazar, revogue a configuração
  GoLiveBypass-iPhone (ou -Android) no painel do Proton VPN."
- O QR some (`src` limpo) quando o painel fecha, depois de 5 minutos sem fechar, ou
  quando a pessoa clica em **Pronto, escaneei**. Nos três casos a conf sai da memória.
- Passos mostrados:
  - **iPhone:** 1. Instale o **WireGuard** pela App Store. 2. Toque em **+** › **Criar
    a partir de código QR**. 3. Dê o nome **GoLiveBypass**. 4. Ligue o túnel antes de
    entrar em live no Discord.
  - **Android:** 1. Instale o **WireGuard** pela Play Store. 2. Toque em **+** ›
    **Escanear código QR**. 3. A conf já vem limitada ao Discord. 4. Ligue o túnel
    antes de entrar em live.

### Entrega B: Arquivo, sem câmera (mais segura, menos prática)

Para quem não quer a chave visível na tela, ou não tem câmera disponível.

- Botão **Salvar .conf**. Abre o diálogo de salvar do macOS com nome sugerido
  `GoLiveBypass.conf` (o nome do arquivo vira o nome do túnel no app) e grava com
  permissão `0600`. A conf **nunca aparece na tela**.
- O app guarda o caminho salvo em memória e oferece **Apagar o arquivo do Mac**
  depois da importação. Apagar com o painel aberto remove o arquivo. Ao fechar o
  painel, se o arquivo ainda existir, aparece um lembrete: "O arquivo
  GoLiveBypass.conf ainda está em <pasta>. Apague depois de importar."
- Passos mostrados:
  - **iPhone, por AirDrop** (criptografado, de aparelho para aparelho, sem passar por
    nuvem): 1. No Finder, clique com o botão direito no arquivo › Compartilhar ›
    AirDrop › seu iPhone. 2. No iPhone, abra com **WireGuard**. 3. Apague o arquivo
    do Mac.
  - **Android, por cabo USB:** 1. Conecte o celular no modo "Transferência de
    arquivos". No macOS isso exige um app de MTP, como o OpenMTP ou o Android File
    Transfer. 2. Copie o arquivo para Downloads. 3. No WireGuard: **+** › **Importar
    de arquivo**. 4. Apague o arquivo do celular e do Mac.
- O texto desaconselha e-mail, WhatsApp, Telegram, iCloud Drive e Google Drive:
  "ficam cópias da chave em servidores de terceiros".

Opções consideradas e descartadas:
- **Chave gerada no celular:** impossível com o Proton (exige ed25519; ver Fatos).
- **Digitar os campos à mão no celular:** a chave privada ficaria visível na tela,
  como no QR, e com 44 caracteres digitados. É pior que as duas entregas.

### Depois de gerar

- O painel mostra uma linha com a última geração: "iPhone · MX-FREE#16 (Mexico City)
  · vale até 21/10/2027". O formato vem de `phoneConf`, com datas em `pt-BR`.
- Gerar de novo cria **outra** chave e outra conf persistente no Proton. A antiga
  continua válida até ser revogada no painel do Proton. O painel diz isso abaixo do
  botão quando já existe uma geração anterior.

### Erros

| Situação | Mensagem no painel |
|---|---|
| Sem conta Proton salva ou modo `.conf` | "Entre na sua conta Proton em Proton Otimizado para gerar a conf do celular." |
| Outra busca Proton em andamento | "Espere a busca de rota atual terminar." (`busy`) |
| Catálogo sem nenhum ping | "Nenhum servidor respondeu ao ping agora. Tente de novo em instantes." |
| `-manual-probe` falhou | "O servidor escolhido não passou no teste. Tente gerar de novo." |
| Sessão expirada / `auth_failed` | "A sessão Proton expirou. Entre de novo em Proton Otimizado." |
| `timeout` | mesma mensagem do Proton Otimizado |
| Diálogo de salvar cancelado | nada acontece e a conf continua em memória |
| `invalid_conf` | "A conf gerada veio incompleta. Tente de novo." |

## Questões abertas a validar no teste real

1. **Conexões simultâneas no Proton Free.** A documentação do `proton-confgen` não diz.
   O teste liga o Mac e o celular ao mesmo tempo e confere se os dois passam tráfego.
   Se um derrubar o outro, o painel ganha o aviso "No Proton Free, use o bypass em um
   aparelho por vez." e o CHANGELOG registra isso.
2. **Nome do dispositivo:** confirmar que `GoLiveBypass-iPhone` aparece no painel do
   Proton.
3. **Fallback IPv6 no iPhone:** com os ranges IPv6 em buraco negro, o Discord do
   iPhone deve conectar pelo IPv4 em poucos segundos.

## Fora do escopo

- Renovar a conf do celular sem escanear de novo. Exigiria `serialNumber` no JSON da
  geração e saída JSON no `-renew-serial`, uma mudança no `proton-confgen`, que é
  compartilhado com a GUI Windows. Fica como follow-up. Em 365 dias, gera-se de novo.
- Listar ou revogar as confs do celular pelo app. A revogação é pelo painel do Proton.
- Exportar a conf `.conf` própria (modo Arquivo .conf) para o celular.
- A mesma função na GUI Windows ou Linux.
- Troca automática de servidor no celular. Se a rota cair, gera de novo.

## Segurança

- A chave privada existe só: no temporário do `proton-confgen` (apagado logo após a
  leitura), na memória do main, no QR exibido ou no arquivo que a pessoa escolheu
  salvar.
- O log registra só o servidor, a plataforma e o resultado, **nunca** o conteúdo da
  conf.
- O canal IPC devolve ao renderer o QR (imagem) e metadados, nunca o texto da conf.
- Cada celular tem chave própria e revogável no painel do Proton, sem afetar o Mac.
- O helper e o sudoers não mudam, então a atualização não pede senha.

## Versão e docs

- Versão `0.8.0` (funcionalidade nova), seção `## [macos-0.8.0]` no CHANGELOG.
- README, seção Uso: item "Usar no celular".
- `docs/acceptance-macos.md`: seção "Celular" com os testes reais.
