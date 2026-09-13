/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Worker } from "worker_threads";

// A consulta do WireSock no Windows é um `powershell.exe`, e é o processo principal do
// Discord (Electron) que paga a criação dele. Medido na VM (win11, 6 vCPU), com o painel
// aberto: ~0,55s de janela parada a cada leitura do painel (5s), e `execFile` não mudou nada
// — a criação (CreateProcessW) é síncrona na thread que chama, só a espera do filho é que
// era assíncrona. Aqui a criação inteira sai do processo principal: uma worker thread
// persistente executa o mesmo PowerShell e devolve o stdout, que o processo principal
// parseia com o mesmo parser (veredito idêntico ao da leitura síncrona).
//
// Só strings cruzam a fronteira. Nenhum objeto do Electron entra na worker, e a worker não
// usa API do Electron: ela é um `child_process` + `worker_threads` comuns.
//
// Uma worker só, para todas as leituras: o handler é síncrono, então watchdog, escada de
// confirmação e status do painel são atendidos em série, na ordem em que chegam — sem fila
// própria, sem worker nova por consulta e sem timer periódico.
const WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
const { execFileSync } = require("child_process");

parentPort.on("message", request => {
    let stdout = null;
    try {
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", request.script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: request.timeoutMs,
        });
        stdout = String(output ?? "").trim() || null;
    } catch {
        stdout = null;
    }
    parentPort.postMessage({ token: request.token, stdout });
});
`;

export type WireSockSnapshotRun =
    | { ran: true; stdout: string | null }
    // A worker não atendeu: sem `worker_threads` neste ambiente, worker morta no meio da
    // consulta ou consulta que passou do limite de espera. Quem chama decide o que fazer —
    // hoje, voltar para a leitura dentro do processo, que é o comportamento anterior.
    | { ran: false; reason: "unavailable" | "interrupted" };

// Folga sobre o timeout do PowerShell (8s): o `execFileSync` da worker já encerra a consulta
// pendurada, este limite existe para uma worker que pare de responder por completo.
const SNAPSHOT_GUARD_MS = 10_000;

interface PendingRun {
    resolve: (run: WireSockSnapshotRun) => void;
}

const pending = new Map<number, PendingRun>();
let worker: Worker | null = null;
let unavailable = false;
let guard: NodeJS.Timeout | null = null;
let nextToken = 1;

function disarmGuard(): void {
    if (guard === null) return;
    clearTimeout(guard);
    guard = null;
}

function failPending(): void {
    const runs = [...pending.values()];
    pending.clear();
    disarmGuard();
    for (const run of runs) run.resolve({ ran: false, reason: "interrupted" });
}

// Um vigia para a worker inteira, armado só enquanto existe consulta em voo e desarmado
// quando a última resposta chega. Não é timer por consulta nem timer periódico.
function armGuard(): void {
    if (guard !== null) return;
    guard = setTimeout(() => {
        guard = null;
        const wedged = worker;
        worker = null;
        failPending();
        if (wedged) void wedged.terminate().catch(() => { });
    }, SNAPSHOT_GUARD_MS);
}

function dropWorker(instance: Worker): void {
    if (worker !== instance) return;
    worker = null;
    failPending();
}

function ensureWorker(): Worker | null {
    if (worker) return worker;
    if (unavailable) return null;
    try {
        const created = new Worker(WORKER_SOURCE, { eval: true });
        // A worker não segura o processo do Discord aberto; `unref` cobre o encerramento
        // normal e `disposeWireSockSnapshotWorker` encerra explicitamente na saída.
        created.unref();
        created.on("message", (message: { token?: unknown; stdout?: unknown; } | null) => {
            const token = Number(message?.token);
            const run = pending.get(token);
            if (!run) return;
            pending.delete(token);
            if (pending.size === 0) disarmGuard();
            const stdout = typeof message?.stdout === "string" && message.stdout ? message.stdout : null;
            run.resolve({ ran: true, stdout });
        });
        created.on("error", () => dropWorker(created));
        created.on("exit", () => dropWorker(created));
        worker = created;
        return created;
    } catch {
        // Sem `worker_threads` (ambiente inesperado): fica registrado para não tentar de novo
        // a cada leitura, e quem chama usa o caminho dentro do processo.
        unavailable = true;
        return null;
    }
}

export function runWireSockSnapshotOutsideMainThread(script: string, timeoutMs: number): Promise<WireSockSnapshotRun> {
    const instance = ensureWorker();
    if (!instance) return Promise.resolve({ ran: false, reason: "unavailable" });
    const token = nextToken++;
    return new Promise<WireSockSnapshotRun>(resolve => {
        pending.set(token, { resolve });
        armGuard();
        try {
            instance.postMessage({ token, script, timeoutMs });
        } catch {
            pending.delete(token);
            if (pending.size === 0) disarmGuard();
            dropWorker(instance);
            resolve({ ran: false, reason: "unavailable" });
        }
    });
}

export function disposeWireSockSnapshotWorker(): void {
    const instance = worker;
    worker = null;
    failPending();
    // Encerrar a worker fecha a sessão de leitura: se ela não pôde ser montada neste
    // ambiente, a próxima sessão do plugin tenta de novo (uma vez, não a cada leitura).
    unavailable = false;
    if (instance) void instance.terminate().catch(() => { });
}
