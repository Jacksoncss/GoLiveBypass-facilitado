import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

const nativeSource = readFileSync(join(repository, "goLiveBypass", "native.ts"), "utf8");
const commonStart = nativeSource.indexOf("const common = [");
const commonEnd = nativeSource.indexOf("const files = [...common]", commonStart);
assert.ok(commonStart >= 0 && commonEnd > commonStart, "requiredFilesForPlatform não encontrado");
const requiredFiles = [...nativeSource
    .slice(commonStart, commonEnd)
    .matchAll(/"([A-Za-z0-9_.-]+\.(?:ts|tsx|json))"/g)]
    .map(match => match[1]);
const compatibilityFiles = ["bug-report.ts", "vpn-snapshot-worker.ts"];

function archiveEntries(archive) {
    return new Set(execFileSync("python3", ["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print('\\n'.join(z.namelist()))", archive], {encoding: "utf8"})
        .split(/\r?\n/)
        .filter(Boolean));
}

function makeSyntheticArchive(remove = "") {
    const root = mkdtempSync(join(tmpdir(), "golive-release-archive-"));
    const source = join(root, "goLiveBypass");
    const archive = join(root, "goLiveBypass-vencord.zip");
    for (const relative of requiredFiles) {
        if (relative === remove) continue;
        const original = join(repository, "goLiveBypass", relative);
        assert.ok(statSync(original).isFile() && statSync(original).size > 0, `fonte ausente ou vazia: ${relative}`);
        const target = join(source, relative);
        mkdirSync(dirname(target), {recursive: true});
        copyFileSync(original, target);
    }
    execFileSync("python3", ["-c", "import pathlib, sys, zipfile\nroot = pathlib.Path(sys.argv[1]).parent\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    for path in (root / 'goLiveBypass').rglob('*'):\n        if path.is_file(): z.write(path, path.relative_to(root).as_posix())", archive]);
    return {root, archive, entries: archiveEntries(archive)};
}

function assertRequiredEntries(entries) {
    for (const relative of requiredFiles.concat(compatibilityFiles)) {
        assert.ok(entries.has(`goLiveBypass/${relative}`), `archive do plugin não contém ${relative}`);
    }
}

test("release gate cria ZIP sintético com requiredFiles e compatibilidade beta-16", () => {
    assert.ok(requiredFiles.length >= 10, "lista required do código atual está curta demais");
    for (const relative of compatibilityFiles) {
        assert.ok(requiredFiles.includes(relative), `requiredFilesForPlatform não protege ${relative}`);
        assert.ok(statSync(join(repository, "goLiveBypass", relative)).isFile(), `módulo de compatibilidade ausente: ${relative}`);
    }

    const fixture = makeSyntheticArchive();
    try {
        assertRequiredEntries(fixture.entries);
    } finally {
        rmSync(fixture.root, {recursive: true, force: true});
    }
});
test("release gate rejeita ZIP incompleto de cada módulo de compatibilidade", () => {
    for (const relative of compatibilityFiles) {
        const fixture = makeSyntheticArchive(relative);
        try {
            assert.throws(
                () => assertRequiredEntries(fixture.entries),
                new RegExp(`archive do plugin não contém ${relative.replace(".", "\\.")}`),
            );
        } finally {
            rmSync(fixture.root, {recursive: true, force: true});
        }
    }
});

console.log("plugin release archive gate: 2/2");
