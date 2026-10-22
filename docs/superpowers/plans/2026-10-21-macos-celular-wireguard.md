# macOS 0.8.0 "Usar no celular": plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O GoLiveBypass do Mac gera uma conf WireGuard própria para iPhone ou Android e a entrega por QR code ou por arquivo, para o app oficial do WireGuard.

**Architecture:**
- Um módulo puro (`phone-conf.ts`) transforma a conf bruta do Proton na conf de cada plataforma.
- Um serviço (`phone/service.ts`, com dependências injetadas) orquestra catálogo → `-manual-probe` com `-device-name`, guarda a conf só em memória e a entrega como QR (SVG) ou arquivo `0600`.
- O main expõe canais IPC `phone:*`; o renderer ganha um painel "Usar no celular".
- Nada toca em `golive.conf`, no helper nem no túnel do Mac.

**Tech Stack:** Electron 33, TypeScript, Vitest, `proton-confgen` (já empacotado), `qrcode-generator@1.4.4` (nova e única dependência de runtime).

**Spec:** `docs/superpowers/specs/2026-10-21-macos-celular-wireguard-design.md`

## Global Constraints

- Diretório do app: `golive-gui-mac/`. Testes: `npm test`. Tipos: `npm run typecheck`.
- A conf do celular **nunca** vai para `golive.conf`, log, configurações ou renderer como texto. O renderer recebe só a imagem do QR (`data:image/svg+xml;base64,…`) e metadados.
- Nomes de dispositivo: `GoLiveBypass-iPhone` e `GoLiveBypass-Android`.
- AllowedIPs iPhone: `162.159.0.0/16, 104.16.0.0/12, 2606:4700::/32, 2a06:98c0::/29` (de `DISCORD_ALLOWED_IPS` + `DISCORD_REJECT_V6`). AllowedIPs Android: `0.0.0.0/0, ::/0`, com `IncludedApplications = com.discord`.
- `PersistentKeepalive = 25` (`DEFAULT_KEEPALIVE`).
- Arquivo salvo com modo `0600`, nome sugerido `GoLiveBypass.conf`.
- QR some depois de **5 minutos** (`PHONE_CONF_TTL_MS = 300_000`), ao fechar o painel ou em "Pronto, escaneei".
- Helper, sudoers e `resources/bin` não mudam.
- Versão `0.8.0`; nada de attribution do Claude em commits ou PRs.
- Copy em português, com acentos, exatamente como na spec.

## Review Focus

1. **Painel fechado no meio da geração:** o resultado que chega depois não pode aparecer nem ficar em memória. Teste no Task 4: `clear()` durante `generate()` descarta o resultado.
2. **Otimizar rota ou troca automática do Mac rodando junto:** as duas buscas compartilham o flag `busy` nos dois sentidos. Testes no Task 4 (serviço) e no Task 5 (`fetchProton` recusa enquanto o celular gera).
3. **Salvar dentro do iCloud Drive** (`~/Library/Mobile Documents/`): a chave iria para a nuvem. `saveTo` devolve o aviso `cloud_folder` e não grava. Teste no Task 4.
4. **Chave privada vazando por mensagem de erro:** `detail` de qualquer falha nunca contém `PrivateKey` nem a chave. Teste no Task 4 com um fetcher falso que devolve a conf na saída de erro.
5. **Túnel do Mac ativo durante a geração:** o serviço não recebe `storeConfig`/`saveSettings` do túnel. Teste no Task 4 confirma que a única escrita de configuração é `phoneConf`.

---

### Task 1: Conf do celular (`buildPhoneConf`)

**Files:**
- Create: `golive-gui-mac/src/main/phone/phone-conf.ts`
- Test: `golive-gui-mac/test/phone/phone-conf.test.ts`

**Interfaces:**
- Consumes: `parseWgConfig` (`src/main/config/parse`, o mesmo que `importConfig` usa), `DISCORD_ALLOWED_IPS`, `DISCORD_REJECT_V6`, `DEFAULT_KEEPALIVE` (`src/main/config/rewrite.ts`).
- Produces:
  - `export type PhonePlatform = 'ios' | 'android'`
  - `export const PHONE_DEVICE_NAME: Record<PhonePlatform, string>`
  - `export function buildPhoneConf(raw: string, platform: PhonePlatform): { ok: true; conf: string } | { ok: false; error: 'invalid_conf' }`

- [ ] **Step 1: Escrever os testes**, com uma conf Proton de exemplo (`PrivateKey`, `Address = 10.2.0.2/32`, `DNS = 10.2.0.1`, `PostUp = x`, `PublicKey`, `Endpoint = 1.2.3.4:51820`, `AllowedIPs = 0.0.0.0/0`):
  - `ios`: contém `AllowedIPs = 162.159.0.0/16, 104.16.0.0/12, 2606:4700::/32, 2a06:98c0::/29` e `PersistentKeepalive = 25`; não contém `DNS`, `PostUp` nem `IncludedApplications`.
  - `android`: contém `DNS = 10.2.0.1`, `IncludedApplications = com.discord` e `AllowedIPs = 0.0.0.0/0, ::/0`; não contém `PostUp`.
  - Um `PersistentKeepalive` já existente não é duplicado.
  - Sem `PrivateKey` (e, separadamente, sem `Endpoint`) → `{ ok: false, error: 'invalid_conf' }`.
  - `PHONE_DEVICE_NAME` é `{ ios: 'GoLiveBypass-iPhone', android: 'GoLiveBypass-Android' }`.
- [ ] **Step 2: Rodar** `npx vitest run test/phone/phone-conf.test.ts`. Esperado: FAIL (módulo inexistente).
- [ ] **Step 3: Implementar** `buildPhoneConf`. Reaproveitar o mapa de chaves canônicas de `rewrite.ts`: exportar `CANONICAL_KEYS` de lá em vez de duplicar, acrescentando `dns: 'DNS'` só no caminho Android.
- [ ] **Step 4: Rodar o teste.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(macos): conf do celular para iPhone e Android`.

### Task 2: QR code

**Files:**
- Modify: `golive-gui-mac/package.json` (`"dependencies": { "qrcode-generator": "1.4.4" }`, versão exata), `golive-gui-mac/package-lock.json`
- Create: `golive-gui-mac/src/main/phone/qr.ts`
- Test: `golive-gui-mac/test/phone/qr.test.ts`

**Interfaces:**
- Produces: `export function confToQrDataUrl(conf: string): string`

- [ ] **Step 1: Instalar** com `npm install --save-exact qrcode-generator@1.4.4`. Conferir no lock que ele não puxa dependência transitiva.
- [ ] **Step 2: Escrever os testes:**
  - O resultado começa com `data:image/svg+xml;base64,`; o SVG decodificado começa com `<svg` e contém `<path` ou `<rect`.
  - Uma conf Android de exemplo do Task 1 (~450 bytes) gera sem lançar.
  - Uma string de 4000 bytes lança `Error('qr_too_large')`.
- [ ] **Step 3: Rodar o teste.** Esperado: FAIL.
- [ ] **Step 4: Implementar.** `qrcode(0, 'M')`, `addData(conf, 'Byte')`, `make()`, `createSvgTag({ cellSize: 4, margin: 4, scalable: true })`. Capturar o erro de overflow da biblioteca e relançar `qr_too_large`.
- [ ] **Step 5: Rodar o teste.** Esperado: PASS.
- [ ] **Step 6: Conferir o empacotamento.** `npm run build:mac` e depois `npx asar list dist-build/mac-universal/GoLiveBypass.app/Contents/Resources/app.asar | grep qrcode-generator`. Esperado: o pacote aparece.
- [ ] **Step 7: Commit** `feat(macos): QR code local para a conf do celular`.

### Task 3: Fetch com nome de dispositivo e validade

**Files:**
- Modify: `golive-gui-mac/src/main/proton/fetch.ts` (`ProtonFetchOpts`, `ProtonFetchResult`, `fetchInner`)
- Test: `golive-gui-mac/test/proton/fetch.test.ts` (reusar o harness `fake()` existente)

**Interfaces:**
- Produces:
  - `ProtonFetchOpts.deviceName?: string` → acrescenta `-device-name <nome>` aos argumentos de geração (`manual`, `speed`, `auto`); não ao catálogo.
  - `ProtonFetchResult.expiresAt?: number` (segundos Unix, de `lastJson(out).expiresAt` quando for inteiro positivo).

- [ ] **Step 1: Escrever os testes:**
  - `manual` com `deviceName: 'GoLiveBypass-iPhone'` → os argumentos contêm `-device-name GoLiveBypass-iPhone -server MX-FREE#16 -manual-probe`, e o resultado tem `expiresAt: 1824000000` quando o JSON falso traz esse valor.
  - `catalog` com `deviceName` → os argumentos não contêm `-device-name`.
  - `deviceName` fora de `/^[\w-]{1,40}$/` é ignorado.
- [ ] **Step 2: Rodar** `npx vitest run test/proton/fetch.test.ts`. Esperado: os novos falham.
- [ ] **Step 3: Implementar** a flag e a leitura de `expiresAt`.
- [ ] **Step 4: Rodar o teste.** Esperado: PASS (inclusive os antigos).
- [ ] **Step 5: Commit** `feat(macos): fetch aceita nome de dispositivo e devolve a validade`.

### Task 4: Serviço do celular

**Files:**
- Create: `golive-gui-mac/src/main/phone/service.ts`
- Test: `golive-gui-mac/test/phone/service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`buildPhoneConf`, `PHONE_DEVICE_NAME`), Task 2 (`confToQrDataUrl`), Task 3 (`deviceName`, `expiresAt`), `pickLowestPing`.
- Produces:
  - `export interface PhoneMeta { platform: PhonePlatform; server: string; country: string; city: string; expiresAt?: number; generatedAt: string }`
  - `export type PhoneError = 'busy' | 'no_routes' | 'probe_failed' | 'auth_failed' | 'timeout' | 'invalid_conf' | 'unknown'`
  - `export interface PhoneDeps { fetch(opts: { mode: 'catalog' | 'manual'; server?: string; deviceName?: string; confOut: string }): Promise<ProtonFetchResult>; tmpPath(): string; readFile(p: string): string; writeFile(p: string, data: string, mode: number): void; rm(p: string): void; exists(p: string): boolean; saveMeta(m: PhoneMeta): void; now(): Date; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void; isBusy(): boolean; home: string }`
  - `export const PHONE_CONF_TTL_MS = 300_000`
  - `export class PhoneConfService { constructor(d: PhoneDeps); get generating(): boolean; generate(platform: PhonePlatform, delivery: 'qr' | 'file'): Promise<{ ok: true; meta: PhoneMeta; qr?: string } | { ok: false; error: PhoneError }>; saveTo(path: string): { ok: true } | { ok: false; error: 'no_conf' | 'cloud_folder' }; deleteSaved(): boolean; savedPath(): string | null; clear(): void }`

- [ ] **Step 1: Escrever os testes**, com `PhoneDeps` falso:
  - **Caminho feliz `qr`:** o primeiro fetch é `mode: 'catalog'`; o segundo é `mode: 'manual'`, com `server` igual ao menor ping do catálogo e `deviceName: 'GoLiveBypass-iPhone'`. O resultado tem `qr` começando com `data:image/svg+xml;base64,` e `meta.server` igual ao servidor escolhido. `saveMeta` é chamado uma vez, `rm(tmp)` é chamado, e o resultado não contém `PrivateKey` em nenhum campo (`JSON.stringify`).
  - **`file`:** o resultado não tem `qr`. `saveTo('/Users/u/Desktop/GoLiveBypass.conf')` chama `writeFile` com modo `0o600` e o conteúdo de `buildPhoneConf`. `savedPath()` devolve o caminho e `deleteSaved()` chama `rm`.
  - **`cloud_folder`:** `saveTo` em `/Users/u/Library/Mobile Documents/com~apple~CloudDocs/x.conf` devolve `{ ok: false, error: 'cloud_folder' }` sem chamar `writeFile`.
  - **`no_conf`:** `saveTo` sem geração anterior.
  - **Catálogo sem ping** → `no_routes`. **Manual falhou** com `error: 'unknown'` → `probe_failed`. `auth_failed` e `timeout` passam direto. Em todos, `rm(tmp)` é chamado.
  - **Vazamento:** um fetch manual falso que devolve `{ ok: false, error: 'unknown', detail: 'PrivateKey = abc' }` → o resultado é `{ ok: false, error: 'probe_failed' }`, sem `detail`.
  - **`busy`:** com `isBusy()` true, ou com outra `generate` em andamento → `busy`, sem chamar `fetch`.
  - **`clear()` durante a geração:** a promise resolve com `{ ok: false, error: 'unknown' }` e `saveTo` depois devolve `no_conf`.
  - **TTL:** depois de `generate`, disparar o timer registrado com `PHONE_CONF_TTL_MS` → `saveTo` devolve `no_conf`.
  - **Única escrita de configuração:** `saveMeta`. O serviço não tem acesso a mais nada.
- [ ] **Step 2: Rodar** `npx vitest run test/phone/service.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - A conf fica num campo privado e é zerada por `clear()`, pelo TTL ou por uma nova `generate`.
  - Um contador de geração descarta resultados obsoletos depois de um `clear()`.
  - `cloud_folder` é qualquer caminho que contenha `/Library/Mobile Documents/`.
- [ ] **Step 4: Rodar o teste.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(macos): serviço que gera e entrega a conf do celular`.

### Task 5: IPC, preload e ligação no main

**Files:**
- Modify: `golive-gui-mac/src/main/ipc.ts`, `golive-gui-mac/src/preload/preload.ts`, `golive-gui-mac/src/main/main.ts`, `golive-gui-mac/src/shared/types.ts`
- Test: `golive-gui-mac/test/ipc.test.ts`

**Interfaces:**
- Consumes: Task 4 (`PhoneConfService`, `PhoneMeta`).
- Produces:
  - Canais: `phone:status` → `{ eligible: boolean; meta: PhoneMeta | null; savedPath: string | null }`; `phone:generate` `{ platform, delivery }`; `phone:save` (abre o `dialog.showSaveDialog` no main, com `defaultPath` `~/Desktop/GoLiveBypass.conf`); `phone:deleteSaved`; `phone:clear`.
  - Preload: `phoneStatus()`, `phoneGenerate(platform, delivery)`, `phoneSave()`, `phoneDeleteSaved()`, `phoneClear()`.
  - `AppSettings.phoneConf?: PhoneMeta`.

- [ ] **Step 1: Escrever os testes do roteador:**
  - `phone:generate` com `{ platform: 'ios', delivery: 'file' }` repassa igual.
  - Com `platform: 'windows'` ou `delivery: 'email'` repassa `undefined`, e o handler responde `{ ok: false, error: 'unknown' }`.
  - `phone:save` não aceita caminho vindo do renderer: o payload é ignorado.
- [ ] **Step 2: Rodar** `npx vitest run test/ipc.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar a validação no roteador e no preload.**
- [ ] **Step 4: Ligar no `main.ts`:**
  - Instanciar `PhoneConfService`. O `fetch` usa um `ProtonFetcher` próprio com `binDir`, `sessionDir(home)`, `username: loadSettings().protonUser` e **sem** `storeConfig`.
  - `tmpPath` em `appDataDir(home)` com prefixo `phone-raw-`.
  - `isBusy` = `protonFetching`. Durante a geração, `protonFetching` fica `true`, então o `fetchProton` e a troca automática recebem `busy`.
  - `eligible` = `connectionMode` `proton` + `protonUser` + `session.json` existente.
  - O log registra só "Conf do celular gerada: <plataforma> · <servidor>" ou "Falha ao gerar a conf do celular: <erro>".
- [ ] **Step 5: Rodar** `npm run typecheck && npm test`. Esperado: tudo PASS.
- [ ] **Step 6: Commit** `feat(macos): canais IPC da conf do celular`.

### Task 6: Painel "Usar no celular"

**Files:**
- Modify: `golive-gui-mac/src/renderer/index.html` (ícone `open-phone` no topo e painel `phone-panel` no padrão do `settings-panel`), `golive-gui-mac/src/renderer/renderer.ts`, `golive-gui-mac/src/renderer/styles.css`

**Interfaces:**
- Consumes: os métodos de preload do Task 5; `openPanel` e `closePanel` existentes.

- [ ] **Step 1: HTML.**
  - Segmentados `phone-platform` (iPhone | Android) e `phone-delivery` (QR code | Arquivo (sem câmera)).
  - Botão `phone-generate`, linha `phone-meta`, `phone-status` e o aviso de chave privada.
  - `<img id="phone-qr" alt="QR code da conf">`, botão `phone-done` ("Pronto, escaneei").
  - Botões `phone-save` e `phone-delete`.
  - Listas de passos `phone-steps-ios-qr`, `phone-steps-android-qr`, `phone-steps-ios-file`, `phone-steps-android-file`, com os textos exatos da spec (Entrega A e B, Erros e Depois de gerar).
- [ ] **Step 2: Renderer.**
  - Ao abrir: `phoneStatus()`. Inelegível → a mensagem de "Entre na sua conta Proton…", sem botão de gerar.
  - Gerar: desabilita o botão, mostra "Gerando a conf do celular… (até 1 min)" e, no fim, mostra o QR ou os botões de arquivo, conforme a entrega.
  - Fechar o painel ou "Pronto, escaneei": `phoneClear()` e `img.src = ''`.
  - Ao fechar com `savedPath` presente: o lembrete de apagar.
  - O QR também some sozinho aos 5 minutos (`setTimeout` de `300_000`), em espelho do TTL do main.
- [ ] **Step 3: CSS.** QR com fundo branco fixo nos dois temas (o leitor precisa de contraste) e largura máxima de 240 px.
- [ ] **Step 4: Verificar no app pelo CDP** (`--remote-debugging-port=9333`):
  - `phoneStatus().eligible` é `true` com a conta salva.
  - Gerar iPhone/QR: aparece o `<img>` com `src` `data:image/svg+xml`, e `document.body.innerText` não contém `PrivateKey`.
  - Fechar o painel deixa o `src` vazio.
  - Gerar Android/Arquivo e salvar na Mesa: o arquivo existe com permissão `-rw-------` (`stat -f %Sp`).
  - Apagar o arquivo pelo botão: ele some.
  - Escolher uma pasta do iCloud Drive mostra o aviso e não grava.
- [ ] **Step 5: Commit** `feat(macos): painel Usar no celular`.

### Task 7: Docs e versão

**Files:**
- Modify: `CHANGELOG.md` (seção `## [macos-0.8.0] - <data>` acima da 0.7.1), `golive-gui-mac/README.md` (Uso), `golive-gui-mac/docs/acceptance-macos.md` (seção "Celular"), `golive-gui-mac/package.json` e `package-lock.json` (`0.8.0`)

- [ ] **Step 1: Escrever.**
  - O CHANGELOG descreve as duas entregas, o isolamento por plataforma, o que fica fora do escopo e os resultados do Task 8.
  - O roteiro de aceitação ganha um item por linha da seção "Questões abertas" da spec, mais os testes do Task 8.
- [ ] **Step 2: Verificar** `git diff --check` e `npm test`.
- [ ] **Step 3: Commit** `docs(macos): Usar no celular na 0.8.0`.

### Task 8: Teste real com os aparelhos

Precisa de quem tem os aparelhos: o usuário com iPhone e Android, ou o amigo que testou no Apple Silicon. Registrar cada resultado no CHANGELOG e no PR.

- [ ] **Step 1: Build e instalação.** `npm run build:mac`, instalar em `/Applications` e abrir.
- [ ] **Step 2: iPhone por QR.**
  - Importar e ligar o túnel. No Safari, abrir `https://www.cloudflare.com/cdn-cgi/trace`: esperado `loc=MX` ou `loc=US` (o range está no túnel).
  - Abrir um site fora da Cloudflare (por exemplo, `https://ifconfig.me`): esperado o IP brasileiro de sempre.
  - No Discord, entrar em live numa call: esperado que o Go Live funcione.
- [ ] **Step 3: iPhone por AirDrop.** Salvar o `.conf`, mandar por AirDrop, abrir com o WireGuard e repetir o trace. Apagar o arquivo pelo app.
- [ ] **Step 4: Android por QR e por arquivo (cabo).**
  - No WireGuard, conferir que o túnel aparece restrito ao Discord.
  - No Chrome, o trace deve mostrar `loc=BR`, porque o Chrome está fora do túnel.
  - No Discord, entrar em live: esperado que funcione.
- [ ] **Step 5: Mac e celular ao mesmo tempo** (questão aberta 1). Com o bypass do Mac ativo e o túnel do celular ligado, os dois traces passam pela VPN. Se um parar de passar tráfego, acrescentar ao painel o aviso "No Proton Free, use o bypass em um aparelho por vez." e registrar no CHANGELOG.
- [ ] **Step 6: Painel do Proton** (questão aberta 2). As confs `GoLiveBypass-iPhone` e `GoLiveBypass-Android` aparecem nas configurações WireGuard da conta.
- [ ] **Step 7: Mac intacto.** `golive.conf`, `connectionMode`, `protonServer` e as rotas do túnel do Mac estão iguais aos de antes da geração (comparar `shasum` do `golive.conf` e as configurações antes e depois).
- [ ] **Step 8: Commit** do registro dos resultados e abertura do PR para `bezumiya/GoLiveBypass` com prints sem dados pessoais. Não mostrar QR real em print: usar um gerado de uma conf falsa.
