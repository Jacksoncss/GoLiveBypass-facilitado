#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWindowsPnpmBuildCommand } from "../goLiveBypass/plugin-build.ts";

const SYSTEM = { SystemRoot: "C:\\Windows" };

// A existência é injetada: nada aqui toca o disco do host, e os caminhos são Windows puros.
function existingPaths(...paths) {
    const existentes = new Set(paths.map(path => path.toLowerCase()));
    return candidate => existentes.has(candidate.toLowerCase());
}

test("entrypoint legado sem extensão é executado por node.exe, não pelo shim", () => {
    const shim = "C:\\Users\\ana\\AppData\\Roaming\\npm\\pnpm.cmd";
    const entrypoint = "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm";
    const result = resolveWindowsPnpmBuildCommand(
        shim,
        { ...SYSTEM, ProgramFiles: "C:\\Program Files" },
        existingPaths(entrypoint, "C:\\Program Files\\nodejs\\node.exe"),
    );

    assert.equal(result.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(result.args, [entrypoint, "build"]);
    // A escolha antiga (executar o shim) é exatamente o que morria antes de compilar.
    assert.notEqual(result.command, shim);
});

test("entrypoint .mjs atual é achado no pacote de uma instalação de projeto", () => {
    const shim = "C:\\Users\\ana & bob\\Meus Projetos\\Equicord\\node_modules\\.bin\\pnpm.cmd";
    const entrypoint = "C:\\Users\\ana & bob\\Meus Projetos\\Equicord\\node_modules\\pnpm\\bin\\pnpm.mjs";
    const result = resolveWindowsPnpmBuildCommand(
        shim,
        { ...SYSTEM, ProgramFiles: "C:\\Program Files" },
        existingPaths(entrypoint, "C:\\Program Files\\nodejs\\node.exe"),
    );

    assert.deepEqual(result.args, [entrypoint, "build"]);
    assert.equal(result.command, "C:\\Program Files\\nodejs\\node.exe");
});

test("prefere .cjs, depois .mjs, depois o entrypoint sem extensão", () => {
    const shim = "C:\\Equicord\\node_modules\\.bin\\pnpm.cmd";
    const bin = "C:\\Equicord\\node_modules\\pnpm\\bin";
    const env = { ...SYSTEM, ProgramFiles: "C:\\Program Files" };
    const node = "C:\\Program Files\\nodejs\\node.exe";

    assert.deepEqual(
        resolveWindowsPnpmBuildCommand(shim, env, existingPaths(`${bin}\\pnpm.cjs`, `${bin}\\pnpm.mjs`, `${bin}\\pnpm`, node)).args,
        [`${bin}\\pnpm.cjs`, "build"],
    );
    assert.deepEqual(
        resolveWindowsPnpmBuildCommand(shim, env, existingPaths(`${bin}\\pnpm.mjs`, `${bin}\\pnpm`, node)).args,
        [`${bin}\\pnpm.mjs`, "build"],
    );
    assert.deepEqual(
        resolveWindowsPnpmBuildCommand(shim, env, existingPaths(`${bin}\\pnpm`, node)).args,
        [`${bin}\\pnpm`, "build"],
    );
});

test("pnpm.exe é executado direto, sem node nem cmd no meio", () => {
    const exe = "C:\\Users\\ana\\AppData\\Local\\pnpm\\pnpm.exe";
    const result = resolveWindowsPnpmBuildCommand(exe, SYSTEM, existingPaths());

    assert.equal(result.command, exe);
    assert.deepEqual(result.args, ["build"]);
    assert.deepEqual(result.pathEntries, ["C:\\Users\\ana\\AppData\\Local\\pnpm", "C:\\Windows\\System32"]);

    const maiusculo = "C:\\USERS\\ANA\\PNPM.EXE";
    assert.equal(resolveWindowsPnpmBuildCommand(maiusculo, SYSTEM, existingPaths()).command, maiusculo);
    assert.deepEqual(resolveWindowsPnpmBuildCommand(maiusculo, SYSTEM, existingPaths()).args, ["build"]);
});

test("sem entrypoint, o fallback continua sendo cmd.exe /d /s /c call <pnpm> build", () => {
    const shim = "C:\\Program Files\\nodejs\\pnpm.cmd";
    const comSpec = "C:\\Windows\\System32\\cmd.exe";
    const result = resolveWindowsPnpmBuildCommand(shim, { ...SYSTEM, ComSpec: comSpec }, existingPaths(comSpec));

    assert.equal(result.command, comSpec);
    assert.deepEqual(result.args, ["/d", "/s", "/c", "call", shim, "build"]);

    // ComSpec ausente ou não verificável: o cmd.exe é derivado do Windows em uso.
    assert.equal(
        resolveWindowsPnpmBuildCommand(shim, { SystemRoot: "D:\\Win", ComSpec: "D:\\Win\\System32\\cmd.exe" }, existingPaths()).command,
        "D:\\Win\\System32\\cmd.exe",
    );
    assert.equal(
        resolveWindowsPnpmBuildCommand(shim, { WINDIR: "E:\\Windows" }, existingPaths()).command,
        "E:\\Windows\\System32\\cmd.exe",
    );
});

test("node.exe é procurado na pasta do shim e depois nos diretórios de programa", () => {
    const shim = "C:\\Equicord\\node_modules\\.bin\\pnpm.cmd";
    const entrypoint = "C:\\Equicord\\node_modules\\pnpm\\bin\\pnpm.cjs";
    const env = {
        ...SYSTEM,
        ProgramW6432: "C:\\Program Files",
        ProgramFiles: "C:\\Arquivos",
        "ProgramFiles(x86)": "C:\\Arquivos (x86)",
    };

    assert.equal(
        resolveWindowsPnpmBuildCommand(
            shim,
            env,
            existingPaths(
                entrypoint,
                "C:\\Equicord\\node_modules\\.bin\\node.exe",
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Arquivos\\nodejs\\node.exe",
                "C:\\Arquivos (x86)\\nodejs\\node.exe",
            ),
        ).command,
        "C:\\Equicord\\node_modules\\.bin\\node.exe",
    );
    assert.equal(
        resolveWindowsPnpmBuildCommand(
            shim,
            env,
            existingPaths(
                entrypoint,
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Arquivos\\nodejs\\node.exe",
                "C:\\Arquivos (x86)\\nodejs\\node.exe",
            ),
        ).command,
        "C:\\Program Files\\nodejs\\node.exe",
    );
    assert.equal(
        resolveWindowsPnpmBuildCommand(
            shim,
            env,
            existingPaths(entrypoint, "C:\\Arquivos (x86)\\nodejs\\node.exe"),
        ).command,
        "C:\\Arquivos (x86)\\nodejs\\node.exe",
    );
});

test("sem node.exe instalado, o node do PATH é usado com o entrypoint absoluto", () => {
    const shim = "C:\\Equicord\\node_modules\\.bin\\pnpm.cmd";
    const entrypoint = "C:\\Equicord\\node_modules\\pnpm\\bin\\pnpm.mjs";
    const result = resolveWindowsPnpmBuildCommand(shim, {}, existingPaths(entrypoint));

    assert.equal(result.command, "node.exe");
    assert.deepEqual(result.args, [entrypoint, "build"]);
    assert.deepEqual(result.pathEntries, ["C:\\Equicord\\node_modules\\.bin", "C:\\Windows\\System32"]);
});

test("pathEntries cobre shim, node e System32 uma única vez cada", () => {
    const shim = "C:\\Users\\ana\\AppData\\Roaming\\npm\\pnpm.cmd";
    const entrypoint = "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs";
    const result = resolveWindowsPnpmBuildCommand(
        shim,
        {
            ...SYSTEM,
            ProgramW6432: "C:\\Program Files",
            ProgramFiles: "C:\\Program Files",
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
        },
        existingPaths(entrypoint, "C:\\Program Files\\nodejs\\node.exe"),
    );

    assert.deepEqual(result.pathEntries, [
        "C:\\Users\\ana\\AppData\\Roaming\\npm",
        "C:\\Program Files\\nodejs",
        "C:\\Program Files (x86)\\nodejs",
        "C:\\Windows\\System32",
    ]);
    assert.equal(new Set(result.pathEntries.map(entry => entry.toLowerCase())).size, result.pathEntries.length);
});

test("caminhos com espaços e & chegam verbatim ao argv, sem passar por shell", () => {
    const shim = "C:\\Users\\ana & bob\\Equicord (beta)\\node_modules\\.bin\\pnpm.cmd";
    const entrypoint = "C:\\Users\\ana & bob\\Equicord (beta)\\node_modules\\pnpm\\bin\\pnpm";
    const result = resolveWindowsPnpmBuildCommand(
        shim,
        { ...SYSTEM, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        existingPaths(entrypoint, "C:\\Windows\\System32\\cmd.exe"),
    );

    assert.equal(result.command, "node.exe");
    assert.deepEqual(result.args, [entrypoint, "build"]);
    assert.equal(result.args[0], entrypoint);
});
