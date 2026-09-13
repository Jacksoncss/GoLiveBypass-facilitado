import { execFile, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));

import { inspectWireSock, inspectWireSockAsync } from "../../goLiveBypass/vpn-windows";

// A leitura do WireSock no Windows é um processo do PowerShell: ~285ms medidos na VM por
// consulta. Enquanto ela era síncrona, o watchdog (a cada 15s) e o status do painel
// congelavam a interface do Discord por esse tempo. Estes testes fixam o contrato do
// caminho novo: mesmo veredito da leitura síncrona, sem segurar a thread principal.

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

// Responde como o PowerShell responderia: na hora (síncrono) ou depois de um atraso que o
// teste controla pelo relógio virtual.
function responderCom(payload: string, atrasoMs = 0): void {
    vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        if (atrasoMs <= 0) callback(null, payload);
        else setTimeout(() => callback(null, payload), atrasoMs);
        return {} as never;
    }) as never);
}

describe("inspeção do WireSock fora da thread principal", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        vi.mocked(execFile).mockReset();
        vi.mocked(execFileSync).mockReset();
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        vi.useRealTimers();
    });

    it("dá o mesmo veredito da leitura síncrona para o mesmo snapshot", async () => {
        const payload = snapshot([{ pid: 4242, commandLine: null }], 4242);
        vi.mocked(execFileSync).mockReturnValue(payload as never);
        responderCom(payload);

        const sincrono = inspectWireSock(PLUGIN_CONFIG);
        const assincrono = await inspectWireSockAsync(PLUGIN_CONFIG);

        expect(sincrono).toMatchObject({ active: true, owned: true, reliable: true, services: ["wiresock-client-service"] });
        expect(assincrono).toEqual(sincrono);
    });

    it("entrega o veredito depois da resposta do PowerShell sem bloquear a thread", async () => {
        vi.useFakeTimers();
        const ordem: string[] = [];
        responderCom(snapshot([{ pid: 4242, commandLine: null }], 4242), 150);

        const veredito = inspectWireSockAsync(PLUGIN_CONFIG).then(value => {
            ordem.push("veredito");
            return value;
        });
        const timerCurto = new Promise<void>(resolve => setTimeout(() => {
            ordem.push("timer");
            resolve();
        }, 10));

        // O timer curto roda com o PowerShell ainda pendente: a thread segue livre. Uma
        // leitura bloqueante resolveria antes de qualquer timer.
        await vi.advanceTimersByTimeAsync(10);
        await timerCurto;
        expect(ordem).toEqual(["timer"]);
        expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(150);
        expect(await veredito).toMatchObject({ active: true, owned: true });
        expect(ordem).toEqual(["timer", "veredito"]);
    });

    it("falha na consulta assíncrona vira estado desconhecido, igual à leitura síncrona", async () => {
        vi.mocked(execFileSync).mockImplementation((() => {
            throw new Error("CIM indisponível");
        }) as never);
        vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
            callback(new Error("CIM indisponível"), "");
            return {} as never;
        }) as never);

        const sincrono = inspectWireSock(PLUGIN_CONFIG);
        const assincrono = await inspectWireSockAsync(PLUGIN_CONFIG);

        expect(sincrono.reliable).toBe(false);
        expect(assincrono).toEqual(sincrono);
    });
});
