import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("electron", () => ({ app: { exit: vi.fn(), quit: vi.fn(), relaunch: vi.fn() } }));

// Worker falsa no lugar de `worker_threads`: ela registra o que o processo principal envia e
// devolve o stdout que o teste escolheu -- exatamente o que a worker real devolve depois de
// criar o PowerShell. É assim que o contrato fica observável: o processo principal fala com a
// worker e NÃO cria processo nenhum.
const workerHost = vi.hoisted(() => {
    interface PostedRequest {
        token: number;
        script: string;
        timeoutMs: number;
    }
    type Reply =
        | { kind: "stdout"; stdout: string | null }
        | { kind: "later"; delayMs: number; stdout: string | null }
        | { kind: "never"; };

    const state = {
        reply: { kind: "stdout", stdout: null } as Reply,
        constructionError: null as Error | null,
        constructions: 0,
        instances: [] as FakeWorker[],
    };

    class FakeWorker {
        readonly posted: PostedRequest[] = [];
        terminated = false;
        unrefCalled = false;
        private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

        constructor(_source: string, _options: unknown) {
            state.constructions++;
            if (state.constructionError) throw state.constructionError;
            state.instances.push(this);
        }

        on(event: string, listener: (...args: unknown[]) => void): this {
            const listeners = this.listeners.get(event) ?? [];
            listeners.push(listener);
            this.listeners.set(event, listeners);
            return this;
        }

        unref(): void {
            this.unrefCalled = true;
        }

        postMessage(request: PostedRequest): void {
            this.posted.push(request);
            const reply = state.reply;
            if (reply.kind === "never") return;
            const deliver = () => this.emit("message", { token: request.token, stdout: reply.stdout });
            if (reply.kind === "later") setTimeout(deliver, reply.delayMs);
            else deliver();
        }

        emit(event: string, ...args: unknown[]): void {
            for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
        }

        terminate(): Promise<number> {
            this.terminated = true;
            return Promise.resolve(0);
        }
    }

    return { state, FakeWorker };
});

vi.mock("node:worker_threads", () => ({ Worker: workerHost.FakeWorker }));

import { disposeWireSockSnapshotWorker } from "../../goLiveBypass/vpn-snapshot-worker";
import { PluginVpnController } from "../../goLiveBypass/vpn-controller";
import { inspectWireSock, inspectWireSockAsync } from "../../goLiveBypass/vpn-windows";

// A consulta do WireSock no Windows é um `powershell.exe`. Medido na VM (win11, 6 vCPU) com o
// painel aberto: ~0,55s de janela parada a cada leitura do painel (5s), e tornar só a espera
// assíncrona não mudou nada -- a criação do processo é síncrona em quem chama. Estes testes
// fixam o contrato do caminho dos leitores periódicos (watchdog e status do painel): quem cria
// o PowerShell é a worker, o processo principal não cria processo nenhum, e o veredito é o
// mesmo da leitura síncrona. Os caminhos que decidem seguem síncronos, dentro do processo.

const PLUGIN_CONFIG = String.raw`C:\Users\teste\AppData\Local\GoLiveBypass\plugin-vpn\wiresock-discord.conf`;
const SERVICE_COMMAND = `"C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe" -config "${PLUGIN_CONFIG}" -allowed-apps "discord.exe"`;

function snapshot(processes: Array<{ pid: number; commandLine: string | null }>, clientProcessId: number | null = null): string {
    return JSON.stringify({
        services: [
            { name: "wiresock-client-service", state: clientProcessId === null ? "Missing" : "Running", command: clientProcessId === null ? null : SERVICE_COMMAND, processId: clientProcessId ?? 0 },
            { name: "wiresock-pro-client-service", state: "Missing", command: null, processId: 0 },
        ],
        processes,
    });
}

// O que o processo principal pediu para a worker criar.
function scriptsSentToWorker(): string[] {
    return workerHost.state.instances.flatMap(instance => instance.posted.map(request => request.script));
}

// O que o processo principal criou por conta própria (leitura síncrona e a queda para dentro
// do processo), montado da chamada real.
function scriptsRunInProcess(): string[] {
    const commands: string[] = [];
    for (const mock of [vi.mocked(execFileSync), vi.mocked(execFile)]) {
        for (const call of mock.mock.calls) {
            const args = call[1] as readonly string[];
            if (call[0] === "powershell.exe" && args?.includes("-Command")) commands.push(args[args.indexOf("-Command") + 1]);
        }
    }
    return commands;
}

function respondSync(payload: string): void {
    vi.mocked(execFileSync).mockReturnValue(payload as never);
}

function respondInProcessAsync(payload: string): void {
    vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(null, payload);
        return {} as never;
    }) as never);
}

function respondWorker(stdout: string | null, delayMs = 0): void {
    workerHost.state.reply = delayMs > 0 ? { kind: "later", delayMs, stdout } : { kind: "stdout", stdout };
}

describe("inspeção do WireSock fora do processo principal", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        vi.mocked(execFile).mockReset();
        vi.mocked(execFileSync).mockReset();
        workerHost.state.reply = { kind: "stdout", stdout: null };
        workerHost.state.constructionError = null;
        workerHost.state.constructions = 0;
        workerHost.state.instances = [];
    });

    afterEach(() => {
        disposeWireSockSnapshotWorker();
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        vi.useRealTimers();
    });

    it("delega a criação do PowerShell e dá o mesmo veredito da leitura síncrona", async () => {
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        respondSync(payload);
        respondWorker(payload);

        const sincrono = inspectWireSock(PLUGIN_CONFIG);
        const assincrono = await inspectWireSockAsync(PLUGIN_CONFIG);

        expect(sincrono).toMatchObject({ active: true, owned: true, reliable: true, services: ["wiresock-client-service"] });
        expect(assincrono).toEqual(sincrono);
        // Mesmo script, mas criado em outro lugar: a worker recebeu o que a leitura síncrona
        // roda, e o processo principal não criou o PowerShell do caminho periódico.
        expect(scriptsSentToWorker()).toEqual(scriptsRunInProcess());
        expect(vi.mocked(execFile)).not.toHaveBeenCalled();
        expect(workerHost.state.instances).toHaveLength(1);
    });

    it("entrega o veredito depois da resposta da worker sem segurar a thread principal", async () => {
        vi.useFakeTimers();
        const ordem: string[] = [];
        respondWorker(snapshot([{ pid: 4242, commandLine: null }], 4242), 150);

        const veredito = inspectWireSockAsync(PLUGIN_CONFIG).then(value => {
            ordem.push("veredito");
            return value;
        });
        const timerCurto = new Promise<void>(resolve => setTimeout(() => {
            ordem.push("timer");
            resolve();
        }, 10));

        // O timer curto roda com o PowerShell ainda pendente: a thread segue livre. Enquanto
        // isso, nada foi criado dentro do processo.
        await vi.advanceTimersByTimeAsync(10);
        await timerCurto;
        expect(ordem).toEqual(["timer"]);
        expect(scriptsRunInProcess()).toEqual([]);

        await vi.advanceTimersByTimeAsync(150);
        expect(await veredito).toMatchObject({ active: true, owned: true });
        expect(ordem).toEqual(["timer", "veredito"]);
    });

    it("falha na consulta vira estado desconhecido, igual à leitura síncrona", async () => {
        vi.mocked(execFileSync).mockImplementation((() => {
            throw new Error("CIM indisponível");
        }) as never);
        respondWorker(null);

        const sincrono = inspectWireSock(PLUGIN_CONFIG);
        const assincrono = await inspectWireSockAsync(PLUGIN_CONFIG);

        expect(sincrono.reliable).toBe(false);
        expect(assincrono).toEqual(sincrono);
        // A queda para dentro do processo só existe quando a worker não atende: aqui ela
        // atendeu (com a falha do PowerShell), então o caminho periódico não criou processo.
        expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    });

    it("reaproveita uma única worker entre leituras, sem worker por consulta", async () => {
        const payload = snapshot([{ pid: 7, commandLine: SERVICE_COMMAND }], 7);
        respondWorker(payload);

        const primeiro = await inspectWireSockAsync(PLUGIN_CONFIG);
        const segundo = await inspectWireSockAsync(PLUGIN_CONFIG);
        const terceiro = await inspectWireSockAsync(PLUGIN_CONFIG);

        expect(primeiro).toEqual(segundo);
        expect(segundo).toEqual(terceiro);
        expect(workerHost.state.instances).toHaveLength(1);
        expect(workerHost.state.instances[0].posted).toHaveLength(3);
        expect(workerHost.state.instances[0].unrefCalled).toBe(true);
        const tokens = workerHost.state.instances[0].posted.map(request => request.token);
        expect(new Set(tokens).size).toBe(3);
    });

    it("worker morta no meio da consulta devolve a leitura para o processo", async () => {
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        workerHost.state.reply = { kind: "never" };
        respondInProcessAsync(payload);

        const pendente = inspectWireSockAsync(PLUGIN_CONFIG);
        workerHost.state.instances[0].emit("exit", 1);

        expect(await pendente).toMatchObject({ active: true, owned: true });
        expect(scriptsRunInProcess()).toHaveLength(1);
    });

    it("consulta pendurada é interrompida no limite e encerra a worker travada", async () => {
        vi.useFakeTimers();
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        workerHost.state.reply = { kind: "never" };
        respondInProcessAsync(payload);

        const pendente = inspectWireSockAsync(PLUGIN_CONFIG);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(await pendente).toMatchObject({ active: true, owned: true });
        expect(workerHost.state.instances[0].terminated).toBe(true);

        // A próxima leitura monta uma worker nova em vez de falar com a travada.
        respondWorker(payload);
        expect(await inspectWireSockAsync(PLUGIN_CONFIG)).toMatchObject({ active: true, owned: true });
        expect(workerHost.state.instances).toHaveLength(2);
    });

    it("ambiente sem worker não perde a leitura nem tenta montar uma por consulta", async () => {
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        workerHost.state.constructionError = new Error("worker_threads indisponível");
        respondInProcessAsync(payload);

        expect(await inspectWireSockAsync(PLUGIN_CONFIG)).toMatchObject({ active: true, owned: true });
        expect(await inspectWireSockAsync(PLUGIN_CONFIG)).toMatchObject({ active: true, owned: true });
        expect(workerHost.state.constructions).toBe(1);
        expect(scriptsRunInProcess()).toHaveLength(2);
    });

    it("o status do painel usa a mesma delegação do watchdog", async () => {
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        respondSync(payload);
        respondWorker(payload);
        // Se a worker não for usada, o teste falha na asserção abaixo em vez de esperar.
        respondInProcessAsync(payload);
        const dataDir = mkdtempSync(join(tmpdir(), "golive-status-"));
        try {
            const controller = new PluginVpnController({
                dataDir,
                guiDataDir: dataDir,
                readSettings: () => ({}),
                isEnabled: () => true,
                log: () => { },
            });

            const sincrono = controller.getStatus();
            const assincrono = await controller.getStatusAsync();

            expect(assincrono.state).toBe(sincrono.state);
            expect(assincrono.owned).toBe(sincrono.owned);
            expect(assincrono.active).toBe(sincrono.active);
            expect(scriptsSentToWorker()).toEqual(scriptsRunInProcess());
            expect(vi.mocked(execFile)).not.toHaveBeenCalled();
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it("os caminhos que decidem continuam com a leitura síncrona no processo", () => {
        respondSync(snapshot([{ pid: 4242, commandLine: null }], 4242));

        expect(inspectWireSock(PLUGIN_CONFIG)).toMatchObject({ active: true, owned: true });
        expect(scriptsRunInProcess()).toHaveLength(1);
        expect(workerHost.state.instances).toHaveLength(0);
    });
});
