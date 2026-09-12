/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Resolução do comando de build do pnpm no Windows.
 *
 * O `resolveWindowsPnpm` do native.ts só prova que o `pnpm.cmd` existe. O shim gerado pelo npm
 * não é o pnpm: ele repassa para o entrypoint JS do pacote (`node_modules\pnpm\bin\pnpm.cjs`) e,
 * quando esse entrypoint perde a extensão (o caso da beta-10), o `call pnpm.cmd build` executado
 * pelo cmd.exe morre antes de compilar qualquer coisa. Aqui a decisão é pura e testável: recebe o
 * caminho do shim, o ambiente e um teste de existência injetável, e devolve o argv exato usado em
 * `execFileSync` com `shell: false`. O caminho principal não monta linha de comando, então espaços
 * e metacaracteres nunca são reinterpretados por um shell.
 *
 * Tudo passa por `path.win32` para que a resolução seja idêntica fora do Windows (é onde os testes
 * rodam), e `pathEntries` devolve só os diretórios de que o comando depende, sem duplicatas.
 */

import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface WindowsPnpmBuildCommand {
    command: string;
    args: string[];
    pathEntries: string[];
}

export type WindowsPnpmBuildEnvironment = Readonly<Record<string, string | undefined>>;
export type PathProbe = (candidate: string) => boolean;

const NODE_EXECUTABLE = "node.exe";
const PNPM_BIN_ENTRYPOINTS = ["pnpm.cjs", "pnpm.mjs", "pnpm"] as const;
const FALLBACK_WINDOWS_ROOT = "C:\\Windows";

function isRegularFile(candidate: string): boolean {
    try {
        return statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function uniquePathEntries(candidates: readonly (string | undefined)[]): string[] {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const key = win32.normalize(candidate).replace(/[\\/]+$/, "").toLowerCase();
        // "." só aparece quando o pnpm veio sem diretório (achado pelo PATH); não é uma pista.
        if (key === "" || key === "." || seen.has(key)) continue;
        seen.add(key);
        entries.push(candidate);
    }
    return entries;
}

function pnpmBinEntrypoint(pnpmPath: string, exists: PathProbe): string | null {
    const shimDir = win32.dirname(pnpmPath);
    if (shimDir === "" || shimDir === ".") return null;
    // Shim do npm: `<prefixo>\pnpm.cmd` ao lado de `<prefixo>\node_modules\pnpm\bin\<entrypoint>`.
    // Pnpm de projeto: `<raiz>\node_modules\.bin\pnpm.cmd` com o pacote um nível acima.
    const packageRoots = [
        win32.join(shimDir, "node_modules", "pnpm"),
        win32.join(win32.dirname(shimDir), "pnpm"),
    ];
    for (const packageRoot of packageRoots) {
        for (const entrypoint of PNPM_BIN_ENTRYPOINTS) {
            const candidate = win32.join(packageRoot, "bin", entrypoint);
            if (exists(candidate)) return candidate;
        }
    }
    return null;
}

function resolveNodeExecutable(pnpmPath: string, env: WindowsPnpmBuildEnvironment, exists: PathProbe): string {
    const shimDir = win32.dirname(pnpmPath);
    const candidates = [
        win32.join(shimDir, NODE_EXECUTABLE),
        env.ProgramW6432 ? win32.join(env.ProgramW6432, "nodejs", NODE_EXECUTABLE) : undefined,
        env.ProgramFiles ? win32.join(env.ProgramFiles, "nodejs", NODE_EXECUTABLE) : undefined,
        env["ProgramFiles(x86)"] ? win32.join(env["ProgramFiles(x86)"], "nodejs", NODE_EXECUTABLE) : undefined,
    ];
    return candidates.find(candidate => candidate !== undefined && exists(candidate)) ?? NODE_EXECUTABLE;
}

function resolveCmdExecutable(env: WindowsPnpmBuildEnvironment, exists: PathProbe): string {
    const comSpec = env.ComSpec;
    if (comSpec && exists(comSpec)) return comSpec;
    return win32.join(env.SystemRoot ?? env.WINDIR ?? FALLBACK_WINDOWS_ROOT, "System32", "cmd.exe");
}

function windowsPathEntries(pnpmPath: string, nodeCommand: string, env: WindowsPnpmBuildEnvironment): string[] {
    const windowsRoot = env.SystemRoot ?? env.WINDIR ?? FALLBACK_WINDOWS_ROOT;
    return uniquePathEntries([
        win32.dirname(pnpmPath),
        win32.dirname(nodeCommand),
        env.ProgramW6432 ? win32.join(env.ProgramW6432, "nodejs") : undefined,
        env.ProgramFiles ? win32.join(env.ProgramFiles, "nodejs") : undefined,
        env["ProgramFiles(x86)"] ? win32.join(env["ProgramFiles(x86)"], "nodejs") : undefined,
        win32.join(windowsRoot, "System32"),
    ]);
}

/**
 * Decide como executar o build do pnpm a partir do shim/executável já localizado no Windows.
 * Ordem: `pnpm.exe` é executado direto; para o shim `pnpm.cmd` (ou equivalente) o entrypoint JS do
 * pacote é executado com `node.exe`; sem entrypoint, cai no `cmd.exe /d /s /c call <pnpm> build`.
 */
export function resolveWindowsPnpmBuildCommand(
    pnpmPath: string,
    env: WindowsPnpmBuildEnvironment = {},
    exists: PathProbe = isRegularFile,
): WindowsPnpmBuildCommand {
    if (win32.extname(pnpmPath).toLowerCase() === ".exe") {
        return {
            command: pnpmPath,
            args: ["build"],
            pathEntries: windowsPathEntries(pnpmPath, NODE_EXECUTABLE, env),
        };
    }

    const entrypoint = pnpmBinEntrypoint(pnpmPath, exists);
    if (entrypoint) {
        const command = resolveNodeExecutable(pnpmPath, env, exists);
        return {
            command,
            args: [entrypoint, "build"],
            pathEntries: windowsPathEntries(pnpmPath, command, env),
        };
    }

    return {
        command: resolveCmdExecutable(env, exists),
        args: ["/d", "/s", "/c", "call", pnpmPath, "build"],
        pathEntries: windowsPathEntries(pnpmPath, NODE_EXECUTABLE, env),
    };
}
