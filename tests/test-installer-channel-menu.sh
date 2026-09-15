#!/bin/sh
# Regressões do item TUI/textual de canal, sem rede nem checkout real.
set -eu

REPO="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SH="$REPO/installer/golivebypass-installer.sh"
PS="$REPO/installer/GoLiveBypass-Installer.ps1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sh -n "$SH"

grep -F 'Mudar canal de atualizacoes' "$SH" >/dev/null
grep -F 'Mudar canal de atualizacoes' "$PS" >/dev/null
grep -F 'change_channel_menu "$root"; continue' "$SH" >/dev/null
grep -F 'Invoke-ChangeChannel $root; continue' "$PS" >/dev/null

awk '/^change_channel_menu\(\) \{/,/^main_menu\(\) \{/' "$SH" | sed '$d' > "$TMP/change.sh"
cat >> "$TMP/change.sh" <<'EOF'
C_BOLD=""; C_OFF=""; C_GREEN=""; C_YELLOW=""; C_DIM=""
CHANNEL_EXPLICIT=0
ASSUME_YES=0
TUI_LOG="${TUI_LOG:-}"
tui_is_interactive() { return 1; }
get_persisted_channel() { printf '%s\n' stable; }
persist_channel() { printf '%s\n' "$2" > "$TUI_LOG"; }
ok() { :; }
warn() { :; }
EOF

# A escolha beta grava imediatamente, sem qualquer chamada de update/build.
printf '2\n' | TUI_LOG="$TMP/beta.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; change_channel_menu "$2"' sh "$TMP/change.sh" "$TMP/checkout"
[ "$(cat "$TMP/beta.log")" = beta ]

# Cancelar não grava e não chama a persistência.
rm -f "$TMP/cancel.log"
printf '0\n' | TUI_LOG="$TMP/cancel.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; change_channel_menu "$2"' sh "$TMP/change.sh" "$TMP/checkout"
[ ! -e "$TMP/cancel.log" ]

# Sem checkout, a opção permanece acionável, mas não grava configuração ambígua.
rm -f "$TMP/no-checkout.log"
TUI_LOG="$TMP/no-checkout.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; change_channel_menu ""' sh "$TMP/change.sh"
[ ! -e "$TMP/no-checkout.log" ]

printf '%s\n' 'installer channel menu: ok'
