import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../installer/GoLiveBypass-Installer.bat", import.meta.url), "utf8");

test("launcher sempre baixa o PS1 atual antes de executa-lo", () => {
    assert.match(source, /set "GLB_TMP=%GLB_SCRIPT%\.download-%RANDOM%-%RANDOM%\.tmp"/);
    assert.match(source, /Invoke-WebRequest[\s\S]*-OutFile \$tmp/);
    assert.match(source, /Test-Path -LiteralPath \$tmp -PathType Leaf/);
    assert.match(source, /\(Get-Item -LiteralPath \$tmp\)\.Length -lt 1024/);
    assert.match(source, /\[CmdletBinding\(\)\]/);
    assert.match(source, /param\(/);
    assert.match(source, /\$PluginFiles = @\(/);
    assert.match(source, /\$null -eq \$errors -or \$errors\.Count -gt 0/);
    assert.match(source, /\[System\.Management\.Automation\.Language\.Parser\]::ParseFile\(\$tmp/);
    assert.match(source, /\[IO\.File\]::(?:Replace|Move)\(\$tmp, \$dest/);
    const download = source.indexOf("Invoke-WebRequest");
    const replace = source.indexOf("[IO.File]::");
    const execute = source.indexOf('-File "%GLB_SCRIPT%"');
    assert.ok(download >= 0 && replace > download && execute > replace, "refresh precisa terminar antes do -File");
    assert.doesNotMatch(source, /^if not exist "%GLB_SCRIPT%" \(/im);
});

test("falha de download nao executa PS1 stale e preserva argumentos no sucesso", () => {
    assert.match(source, /:download_failed[\s\S]*del \/q "%GLB_TMP%"/);
    assert.match(source, /if errorlevel 1 goto :download_failed/);
    assert.match(source, /if not exist "%GLB_SCRIPT%" goto :download_failed/);
    assert.match(source, /:download_failed[\s\S]*A copia anterior nao sera executada/);
    assert.match(source, /-File "%GLB_SCRIPT%" %\*/);
    assert.match(source, /:download_failed[\s\S]*pause[\s\S]*exit \/b 1/);
});

console.log("installer BAT refresh source guard: 2/2");
