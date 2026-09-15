#!/bin/sh
# Dois estados que nao podem ser confundidos ao mexer em um dos lados:
#   - o standalone CLI continua bloqueado de proposito (bloqueio dentro dele mesmo);
#   - o instalador do plugin esta liberado e apenas avisa que a linha WireGuard e beta.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

sh -n "$ROOT/standalone/golivebypass-standalone.sh"
sh -n "$ROOT/installer/golivebypass-installer.sh"

# 1. Standalone CLI: bloqueio proprio, nos dois scripts.
grep -F 'O standalone CLI esta temporariamente indisponivel.' "$ROOT/standalone/golivebypass-standalone.sh" >/dev/null
grep -F 'Use a GUI 2.0.0 de teste' "$ROOT/standalone/golivebypass-standalone.sh" >/dev/null
grep -F 'exit 1' "$ROOT/standalone/golivebypass-standalone.sh" >/dev/null
grep -F 'O standalone CLI esta temporariamente indisponivel.' "$ROOT/standalone/GoLiveBypass-Standalone.ps1" >/dev/null
grep -F 'Use a GUI 2.0.0 de teste' "$ROOT/standalone/GoLiveBypass-Standalone.ps1" >/dev/null

# 2. Instalador Linux do plugin: canais stable/beta, aviso honesto e convite a
# participar dos testes, sem qualquer bloqueio.
HEAD_SH=$(sed -n '1,/^set -eu$/p' "$ROOT/installer/golivebypass-installer.sh")
printf '%s\n' "$HEAD_SH" | grep -F 'Stable e a opcao recomendada' >/dev/null
printf '%s\n' "$HEAD_SH" | grep -F 'Beta e opcional' >/dev/null
printf '%s\n' "$HEAD_SH" | grep -F 'sistema ainda nao e estavel' >/dev/null
printf '%s\n' "$HEAD_SH" | grep -F 'ajuda a comunidade' >/dev/null
printf '%s\n' "$HEAD_SH" | grep -F 'https://github.com/bezumiya/GoLiveBypass/issues' >/dev/null
printf '%s\n' "$HEAD_SH" | grep -F 'O standalone continua separado' >/dev/null
if printf '%s\n' "$HEAD_SH" | grep -Fq 'exit 1'; then
    printf '%s\n' 'instalador Linux voltou a bloquear: aviso de beta virou saida antecipada' >&2
    exit 1
fi
if printf '%s\n' "$HEAD_SH" | grep -Fq 'Nenhuma instalacao foi realizada'; then
    printf '%s\n' 'instalador Linux ainda anuncia instalacao bloqueada' >&2
    exit 1
fi

# 3. Instalador Windows do plugin: os dois canais e o mesmo aviso honesto.
HEAD_PS=$(sed -n '1,/^\$ErrorActionPreference/p' "$ROOT/installer/GoLiveBypass-Installer.ps1")
printf '%s\n' "$HEAD_PS" | grep -F 'Stable e a opcao recomendada' >/dev/null
printf '%s\n' "$HEAD_PS" | grep -F 'Beta e opcional' >/dev/null
printf '%s\n' "$HEAD_PS" | grep -F 'sistema ainda nao e estavel' >/dev/null
printf '%s\n' "$HEAD_PS" | grep -F 'ajuda a comunidade' >/dev/null
printf '%s\n' "$HEAD_PS" | grep -F 'https://github.com/bezumiya/GoLiveBypass/issues' >/dev/null

echo 'standalone status warnings: ok'
