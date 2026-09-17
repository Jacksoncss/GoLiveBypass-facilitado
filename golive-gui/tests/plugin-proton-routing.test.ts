import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

import { PluginVpnController } from "../../goLiveBypass/vpn-controller";

/**
 * Contratos observáveis do catálogo manual de rotas do plugin: catálogo
 * progressivo, sessão efêmera de medição, recusa de medição obsoleta,
 * concorrência, aplicação por staging e detalhe preservado do CAPTCHA.
 *
 * O helper externo é substituído por um processo roteirizado: o teste observa
 * o que a ponte devolve, o que fica em disco e os argumentos entregues ao
 * helper.
 */

const helper = vi.hoisted(() => {
  type Script = {
    /** Conteúdo gravado no arquivo de `-output` (perfil gerado pelo helper). */
    output?: string;
    /** Conteúdo gravado no arquivo de `-session-file` (sessão renovada no login). */
    session?: string;
    json?: Record<string, unknown>;
    code?: number;
    /** Mantém o processo aberto até `finish()`, para observar o meio da operação. */
    hold?: boolean;
  };
  const scripts: Script[] = [];
  const spawnWaiters: Array<() => void> = [];
  const progressWaiters: Array<{ count: number; resolve: () => void }> = [];
  let finishChild: (() => void) | null = null;
  let writeStderr: ((chunk: string) => void) | null = null;
  const api = {
    spawns: 0,
    args: [] as string[],
    stdin: [] as string[],
    progressCount: 0,
    script(script: Script) {
      scripts.push(script);
    },
    nextScript(): Script {
      return scripts.shift() ?? {};
    },
    useChild(finish: () => void, write: (chunk: string) => void) {
      finishChild = finish;
      writeStderr = write;
    },
    notifySpawn() {
      for (const waiter of spawnWaiters.splice(0)) waiter();
    },
    emit(event: unknown) {
      api.progressCount++;
      writeStderr?.(`GOLIVE_PROGRESS ${JSON.stringify(event)}\n`);
      for (const waiter of [...progressWaiters]) {
        if (waiter.count > api.progressCount) continue;
        progressWaiters.splice(progressWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    finish() {
      const finish = finishChild;
      finishChild = null;
      finish?.();
    },
    async waitForSpawn() {
      if (api.spawns > 0) return;
      await new Promise<void>(resolve => spawnWaiters.push(resolve));
    },
    async waitForProgress(count: number) {
      if (api.progressCount >= count) return;
      await new Promise<void>(resolve => progressWaiters.push({ count, resolve }));
    },
  };
  return api;
});

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
  execFile: vi.fn(),
  spawn: vi.fn((_exe: string, args: string[]) => {
    const script = helper.nextScript();
    helper.spawns++;
    helper.args = args;
    let finished = false;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn((value?: string) => helper.stdin.push(String(value ?? ""))) }),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", 143));
        return true;
      }),
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      const outputAt = args.indexOf("-output");
      if (script.output !== undefined && outputAt >= 0 && args[outputAt + 1]) fs.writeFileSync(args[outputAt + 1], script.output);
      const sessionAt = args.indexOf("-session-file");
      if (script.session !== undefined && sessionAt >= 0 && args[sessionAt + 1]) fs.writeFileSync(args[sessionAt + 1], script.session);
      if (script.json !== undefined) child.stdout.emit("data", Buffer.from(JSON.stringify(script.json)));
      child.emit("close", script.code ?? 0);
    };
    helper.useChild(finish, chunk => child.stderr.emit("data", Buffer.from(chunk)));
    helper.notifySpawn();
    if (script.hold) return child;
    queueMicrotask(finish);
    return child;
  }),
}));

vi.mock("electron", () => ({ app: { relaunch: vi.fn(), exit: vi.fn() } }));

vi.mock("../../goLiveBypass/vpn-linux", async importOriginal => {
  const actual = await importOriginal<typeof import("../../goLiveBypass/vpn-linux")>();
  return {
    ...actual,
    // Sem namespace Linux real: a rota está sempre inativa e nenhuma sonda da
    // máquina de teste influencia o estado observado.
    inspectLinuxNetworkSync: () => ({
      active: false,
      owned: false,
      reliable: true,
      namespace: null,
      interfaceName: null,
      namespaceExists: false,
      interfaceExists: false,
      externalConflict: false,
      reason: null,
    }),
    linuxDependencyIssues: () => [],
  };
});

const SESSION_PLAINTEXT = '{"UID":"uid-de-teste","AccessToken":"token-de-teste"}';
const PERFIL_ANTERIOR = [
  "perfil anterior preservado",
  "[Interface]",
  "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "Address = 10.2.0.2/32",
  "[Peer]",
  "PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  "AllowedIPs = 0.0.0.0/0",
  "Endpoint = 192.0.2.8:51820",
  "",
].join("\n");
const PERFIL_NOVO = PERFIL_ANTERIOR
  .replace("192.0.2.8:51820", "198.51.100.9:51820")
  .replace("perfil anterior preservado", "perfil novo promovido");
/** Perfil sem PrivateKey: o helper promoveu, mas não é um WireGuard utilizável. */
const PERFIL_INUTIL = "[Interface]\nAddress = 10.2.0.2/32\n[Peer]\nAllowedIPs = 0.0.0.0/0\nEndpoint = 192.0.2.8:51820\n";
const CONTA = "conta@proton.me";
const CONTA_NORMALIZADA = "conta";
const CATALOGO = {
  success: true,
  routes: [
    { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44 },
    { server: "NL#2", country: "NL", city: "Amsterdam", tier: "Plus", load: 20, score: 1.25 },
  ],
};

const globalScope = globalThis as {
  __GOLIVE_SAFE_STORAGE__?: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
};

const temporaryRoots: string[] = [];
const previousHelperOverride = process.env.GOLIVE_PLUGIN_PROTON_CONFGEN;

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** Diretório de dados com sessão cifrada e, opcionalmente, perfil anterior. */
function dataDirWithSession(profile?: string): string {
  const dir = temporaryRoot("golive-plugin-rotas-");
  fs.writeFileSync(path.join(dir, "proton-session.json"), JSON.stringify({
    version: 1,
    format: "electron-safe-storage",
    ciphertext: Buffer.from(SESSION_PLAINTEXT, "utf8").toString("base64"),
  }), { mode: 0o600 });
  if (profile !== undefined) fs.writeFileSync(path.join(dir, "wireguard.conf"), profile, { mode: 0o600 });
  return dir;
}

function helperExecutable(): string {
  const dir = temporaryRoot("golive-plugin-helper-");
  const file = path.join(dir, "proton-confgen");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

type Harness = {
  controller: PluginVpnController;
  settings: {
    mode: string;
    protonUsername: string;
    protonCountry: string;
    protonFreeOnly: boolean;
    protonAutoPing: boolean;
  };
};

function controllerFor(dir: string, overrides: Partial<Harness["settings"]> = {}): Harness {
  const settings = {
    mode: "proton",
    protonUsername: CONTA,
    protonCountry: "US",
    protonFreeOnly: true,
    protonAutoPing: true,
    ...overrides,
  };
  const controller = new PluginVpnController({
    dataDir: dir,
    guiDataDir: dir,
    readSettings: () => settings,
    isEnabled: () => true,
    log: () => {},
  });
  return { controller, settings };
}

function catalogEvent(server: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const br = server.startsWith("US");
  return {
    phase: "catalog",
    total: 2,
    tested: 0,
    succeeded: 0,
    server,
    country: br ? "US" : "NL",
    city: br ? "New York" : "Amsterdam",
    tier: "Free",
    load: 12,
    score: 3.5,
    ...extra,
  };
}

/** Descobre uma vez e devolve o identificador da medição concluída. */
async function discoverOnce(harness: Harness, json: Record<string, unknown> = CATALOGO): Promise<string> {
  helper.script({ json });
  const result = await harness.controller.discoverProtonRoutes({ requestId: "req-catalogo" });
  if (!result.success || !result.measurementId) throw new Error(`descoberta falhou: ${result.error}`);
  return result.measurementId;
}

beforeEach(() => {
  helper.spawns = 0;
  helper.args = [];
  helper.stdin = [];
  helper.progressCount = 0;
  process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperExecutable();
  globalScope.__GOLIVE_SAFE_STORAGE__ = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  };
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (previousHelperOverride === undefined) delete process.env.GOLIVE_PLUGIN_PROTON_CONFGEN;
  else process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = previousHelperOverride;
  delete globalScope.__GOLIVE_SAFE_STORAGE__;
});

describe("catálogo manual progressivo", () => {
  it("preenche a mesma candidata conforme a medição chega e expõe só metadados públicos", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    helper.script({ hold: true, json: CATALOGO });

    const discovery = harness.controller.discoverProtonRoutes({ requestId: "req-progressivo" });
    await helper.waitForSpawn();

    helper.emit(catalogEvent("US#1"));
    await helper.waitForProgress(1);
    const anunciada = harness.controller.getRouteDiscoveryStatus();
    expect(anunciada.active).toBe(true);
    expect(anunciada.phase).toBe("catalog");
    expect(anunciada.routes).toEqual([
      { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, status: "testing" },
    ]);

    helper.emit(catalogEvent("US#1", { pingMs: 44, tested: 1 }));
    await helper.waitForProgress(2);
    const medida = harness.controller.getRouteDiscoveryStatus();
    expect(medida.routes).toEqual([
      { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44, status: "success" },
    ]);

    // Ping fora do limite utilizável não derruba o catálogo: a rota aparece sem ping.
    helper.emit(catalogEvent("NL#2", { pingMs: 1200, tested: 2, succeeded: 1 }));
    await helper.waitForProgress(3);
    const comFalha = harness.controller.getRouteDiscoveryStatus();
    expect(comFalha.routes.map(route => route.server)).toEqual(["US#1", "NL#2"]);
    expect(comFalha.routes[1].pingMs).toBeUndefined();

    helper.finish();
    const resultado = await discovery;
    expect(resultado.success).toBe(true);
    expect(resultado.measurementId).toBe(comFalha.measurementId);
    expect(resultado.routes?.map(route => route.server)).toEqual(["US#1", "NL#2"]);
    expect(resultado.routes?.[0]).toMatchObject({ server: "US#1", pingMs: 44, status: "success" });
    expect(resultado.routes?.[1]).toMatchObject({ server: "NL#2", status: "failed" });

    // Nenhum segredo da sessão, chave ou endpoint atravessa a fronteira.
    const publico = JSON.stringify({ resultado, status: harness.controller.getRouteDiscoveryStatus() });
    expect(publico).not.toContain("uid-de-teste");
    expect(publico).not.toContain("token-de-teste");
    expect(publico).not.toContain("PrivateKey");
    expect(publico).not.toContain("Endpoint");
    expect(publico).not.toContain("AAAAAAAAAAA");
  });

  it("descreve a descoberta concluída no snapshot consultável", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    const status = harness.controller.getRouteDiscoveryStatus();
    expect(status.active).toBe(false);
    expect(status.phase).toBe("completed");
    expect(status.measurementId).toBe(measurementId);
    expect(status.requestId).toBe("req-catalogo");
    expect(status.total).toBe(2);
    expect(status.measured).toBe(1);
    expect(status.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("sessão efêmera de medição", () => {
  it("recusa seleção com identificador de descoberta substituída", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const antiga = await discoverOnce(harness);
    const nova = await discoverOnce(harness);
    expect(nova).not.toBe(antiga);
    const spawns = helper.spawns;

    const obsoleta = await harness.controller.selectProtonRoute({ measurementId: antiga, server: "US#1" });
    expect(obsoleta.success).toBe(false);
    expect(obsoleta.error).toContain("não é mais a atual");
    expect(helper.spawns).toBe(spawns);
  });

  it("recusa rota fora do catálogo ou sem ping válido sem chamar o helper", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);
    const spawns = helper.spawns;

    const desconhecida = await harness.controller.selectProtonRoute({ measurementId, server: "JP#7" });
    expect(desconhecida.success).toBe(false);
    expect(desconhecida.error).toContain("não pertence à medição atual");

    const semPing = await harness.controller.selectProtonRoute({ measurementId, server: "NL#2" });
    expect(semPing.success).toBe(false);
    expect(semPing.error).toContain("sem ping válido");

    expect(helper.spawns).toBe(spawns);
  });

  it("recusa a medição quando a conta ou os filtros mudaram", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    harness.settings.protonCountry = "NL";
    const filtro = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });
    expect(filtro.success).toBe(false);
    expect(filtro.error).toContain("preferências Proton mudaram");

    harness.settings.protonCountry = "US";
    harness.settings.protonUsername = "outra@proton.me";
    const conta = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });
    expect(conta.success).toBe(false);
    expect(conta.error).toContain("conta Proton mudou");
  });

  it("expira a medição pelo prazo", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));

    expect(harness.controller.getRouteDiscoveryStatus().measurementId).toBeNull();
    const expirada = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });
    expect(expirada.success).toBe(false);
    expect(expirada.error).toContain("expirou");
    expect(helper.spawns).toBe(1);
  });
});

describe("concorrência da descoberta", () => {
  it("bloqueia descoberta, otimização e seleção simultâneas e cancela só a descoberta pedida", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    helper.script({ hold: true, json: CATALOGO });

    const discovery = harness.controller.discoverProtonRoutes({ requestId: "req-1" });
    await helper.waitForSpawn();

    const segunda = await harness.controller.discoverProtonRoutes({ requestId: "req-2" });
    expect(segunda.success).toBe(false);
    expect(segunda.error).toContain("Já existe uma descoberta");

    const otimizacao = await harness.controller.optimizeProton({ requestId: "opt-1" });
    expect(otimizacao.success).toBe(false);
    expect(otimizacao.error).toContain("Cancele a descoberta de rotas");

    helper.emit(catalogEvent("US#1", { pingMs: 44, tested: 1 }));
    await helper.waitForProgress(1);
    const measurementId = harness.controller.getRouteDiscoveryStatus().measurementId;
    expect(measurementId).not.toBeNull();

    const selecao = await harness.controller.selectProtonRoute({ measurementId: measurementId ?? "", server: "US#1" });
    expect(selecao.success).toBe(false);
    expect(selecao.error).toContain("ainda está em andamento");

    expect(harness.controller.cancelProtonRouteDiscovery("req-outra")).toBe(false);
    expect(harness.controller.cancelProtonRouteDiscovery("req-1")).toBe(true);

    const cancelada = await discovery;
    expect(cancelada.success).toBe(false);
    expect(cancelada.cancelled).toBe(true);
    expect(cancelada.measurementId).toBe(measurementId);
    // Catálogo parcial continua visível e utilizável para seleção.
    expect(cancelada.routes).toEqual([
      { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44, status: "success" },
    ]);
    expect(harness.controller.getRouteDiscoveryStatus().active).toBe(false);
    expect(harness.controller.cancelProtonRouteDiscovery("req-1")).toBe(false);
  });

  it("libera nova descoberta depois do cancelamento", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    helper.script({ hold: true, json: CATALOGO });
    const primeira = harness.controller.discoverProtonRoutes({ requestId: "req-1" });
    await helper.waitForSpawn();
    expect(harness.controller.cancelProtonRouteDiscovery()).toBe(true);
    await primeira;

    helper.script({ json: CATALOGO });
    const segunda = await harness.controller.discoverProtonRoutes({ requestId: "req-2" });
    expect(segunda.success).toBe(true);
    expect(helper.spawns).toBe(2);
  });
});

describe("aplicação da rota escolhida", () => {
  it("promove pelo helper com o servidor exato e grava o marcador da conta", async () => {
    const dir = dataDirWithSession(PERFIL_ANTERIOR);
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    helper.script({
      output: PERFIL_NOVO,
      json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41, country: "US", city: "New York", tier: "Free", load: 9, score: 4, endpoint: "192.0.2.9:51820" },
    });
    const selecao = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });

    expect(selecao.success).toBe(true);
    expect(selecao).toMatchObject({ server: "US#1", country: "US", city: "New York", tier: "Free", load: 9, score: 4, pingMs: 41 });
    expect(helper.args).toContain("-manual-probe");
    expect(helper.args[helper.args.indexOf("-server") + 1]).toBe("US#1");

    expect(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8")).toBe(PERFIL_NOVO);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, "wireguard-profile-account.json"), "utf8")) as Record<string, unknown>;
    expect(marcador).toMatchObject({ username: CONTA_NORMALIZADA, country: "US", freeOnly: true, autoPing: true });

    // Endpoint e arquivo de configuração do helper não sobem para o renderer.
    const publico = JSON.stringify(selecao);
    expect(publico).not.toContain("192.0.2.9");
    expect(publico).not.toContain("wireguard.conf");
    expect(publico).not.toContain("AAAAAAAAAAA");
  });

  it("restaura o perfil anterior quando a rota promovida não é um WireGuard válido", async () => {
    const dir = dataDirWithSession(PERFIL_ANTERIOR);
    fs.writeFileSync(path.join(dir, "wireguard-profile-account.json"), JSON.stringify({
      schema: 1,
      username: CONTA,
      country: "NL",
      freeOnly: false,
      autoPing: true,
    }), { mode: 0o600 });
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    helper.script({
      output: PERFIL_INUTIL,
      json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41 },
    });
    const selecao = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });

    expect(selecao.success).toBe(false);
    expect(selecao.error).toContain("PrivateKey");
    expect(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8")).toBe(PERFIL_ANTERIOR);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, "wireguard-profile-account.json"), "utf8")) as Record<string, unknown>;
    expect(marcador).toMatchObject({ country: "NL", freeOnly: false });
    expect(JSON.stringify(selecao)).not.toContain("AAAAAAAAAAA");
  });

  it("remove o perfil promovido inválido quando não existia configuração anterior", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    helper.script({
      output: PERFIL_INUTIL,
      json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41 },
    });
    const selecao = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });

    expect(selecao.success).toBe(false);
    expect(fs.existsSync(path.join(dir, "wireguard.conf"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wireguard-profile-account.json"))).toBe(false);
  });

  it("mantém o perfil anterior quando o helper rejeita a rota", async () => {
    const dir = dataDirWithSession(PERFIL_ANTERIOR);
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);

    helper.script({ code: 1, json: { success: false, manual: true, error: "peer WireGuard ausente" } });
    const selecao = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });

    expect(selecao.success).toBe(false);
    expect(selecao.error).toContain("peer WireGuard ausente");
    expect(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8")).toBe(PERFIL_ANTERIOR);
  });

  it("cancela a aplicação em voo e preserva o perfil anterior", async () => {
    const dir = dataDirWithSession(PERFIL_ANTERIOR);
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);
    helper.script({
      hold: true,
      output: PERFIL_NOVO,
      json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41 },
    });

    const selecao = harness.controller.selectProtonRoute({ measurementId, server: "US#1" });
    await vi.waitFor(() => expect(helper.spawns).toBe(2));
    expect(harness.controller.cancelProtonRouteSelection()).toBe(true);

    await expect(selecao).resolves.toMatchObject({ success: false, cancelled: true });
    expect(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8")).toBe(PERFIL_ANTERIOR);
    expect(harness.controller.cancelProtonRouteSelection()).toBe(false);
  });

  it("serializa a importação customizada depois de uma seleção em voo", async () => {
    const dir = dataDirWithSession(PERFIL_ANTERIOR);
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);
    helper.script({
      hold: true,
      output: PERFIL_NOVO,
      json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41 },
    });
    const custom = path.join(temporaryRoot("golive-custom-conf-"), "custom.conf");
    const customProfile = PERFIL_ANTERIOR.replace("192.0.2.8:51820", "203.0.113.7:51820");
    fs.writeFileSync(custom, customProfile);

    const selecao = harness.controller.selectProtonRoute({ measurementId, server: "US#1" });
    await vi.waitFor(() => expect(helper.spawns).toBe(2));
    const importacao = harness.controller.importCustomConfig(custom);
    helper.finish();

    await expect(selecao).resolves.toMatchObject({ success: true, server: "US#1" });
    await expect(importacao).resolves.toMatchObject({ success: true, path: path.join(dir, "wireguard.conf") });
    expect(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8")).toBe(customProfile);
  });

  it("prepara a rota sem ativar quando a VPN está inativa", async () => {
    const dir = dataDirWithSession();
    const harness = controllerFor(dir);
    const measurementId = await discoverOnce(harness);
    helper.script({ output: PERFIL_NOVO, json: { success: true, manual: true, preflight: "success", server: "US#1", pingMs: 41 } });

    const selecao = await harness.controller.selectProtonRoute({ measurementId, server: "US#1" });

    expect(selecao.success).toBe(true);
    expect(selecao.message).toContain("próxima ativação");
    expect(harness.controller.getStatus().active).toBe(false);
  });
});

describe("login e verificação de segurança", () => {
  const captchaUrl = "https://vpn-api.proton.me/core/v4/captcha?Token=desafio-123";

  it("preserva recusa e cancelamento da verificação como motivos distintos", async () => {
    const dir = temporaryRoot("golive-plugin-login-");
    const harness = controllerFor(dir);
    helper.script({ code: 1, json: { code: "CAPTCHA_REQUIRED", captchaUrl } });

    const recusado = await harness.controller.loginProton({ username: CONTA, password: "senha" }, () =>
      Promise.resolve({ ok: false, code: "CAPTCHA_INVALID" as const, message: "A verificação expirou. Inicie o login novamente." }));
    expect(recusado).toMatchObject({ success: false, code: "CAPTCHA_INVALID", retryable: true });
    expect(recusado.message).toContain("expirou");

    helper.script({ code: 1, json: { code: "CAPTCHA_REQUIRED", captchaUrl } });
    const cancelado = await harness.controller.loginProton({ username: CONTA, password: "senha" }, () =>
      Promise.resolve({ ok: false, code: "CAPTCHA_CANCELLED" as const }));
    expect(cancelado).toMatchObject({ success: false, code: "CAPTCHA_CANCELLED" });
    expect(cancelado.message).toContain("cancelada");
  });

  it("entrega o token resolvido ao helper e conclui o login", async () => {
    const dir = temporaryRoot("golive-plugin-login-ok-");
    const harness = controllerFor(dir);
    helper.script({ code: 1, json: { code: "CAPTCHA_REQUIRED", captchaUrl } });
    helper.script({ session: SESSION_PLAINTEXT, json: { success: true, username: CONTA } });

    const resultado = await harness.controller.loginProton({ username: CONTA, password: "senha" }, url => {
      expect(url).toContain("Token=desafio-123");
      return Promise.resolve({ ok: true as const, token: "desafio-123:token-valido" });
    });

    expect(resultado.success).toBe(true);
    expect(resultado.username).toBe(CONTA_NORMALIZADA);
    expect(helper.stdin).toHaveLength(2);
    expect(helper.stdin[1]).toContain("desafio-123:token-valido");
  });
});
