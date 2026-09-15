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
TUI_MODE="${TUI_MODE:-text}"
TUI_CHOICE="${TUI_CHOICE:-3}"
tui_is_interactive() { [ "$TUI_MODE" = tui ]; }
tui_menu() { printf '%s\n' "$TUI_CHOICE"; }
get_persisted_channel() { if [ -f "$TUI_LOG" ]; then cat "$TUI_LOG"; else printf '%s\n' stable; fi; }
persist_channel() { printf '%s\n' "$2" > "$TUI_LOG"; }
install_plugin_source() { install_calls=$((install_calls + 1)); }
do_update_from_zip() { update_calls=$((update_calls + 1)); }
build_mod() { build_calls=$((build_calls + 1)); }
inject_mod() { inject_calls=$((inject_calls + 1)); }
install_calls=0; update_calls=0; build_calls=0; inject_calls=0
ok() { :; }
warn() { :; }
EOF

# A escolha beta grava e a confirmação relê o valor realmente persistido.
printf '2\n' | TUI_LOG="$TMP/beta.log" CALL_LOG="$TMP/beta-calls.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; CALL_LOG="$CALL_LOG"; change_channel_menu "$2"; printf "%s %s %s %s\n" "$install_calls" "$update_calls" "$build_calls" "$inject_calls" > "$CALL_LOG"' sh "$TMP/change.sh" "$TMP/checkout"
[ "$(cat "$TMP/beta.log")" = beta ]
# O ramo TUI também persiste a escolha sem executar ações do instalador.
rm -f "$TMP/tui.log"
TUI_MODE=tui TUI_CHOICE=2 TUI_LOG="$TMP/tui.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; TUI_MODE=tui; TUI_CHOICE=2; change_channel_menu "$2"' sh "$TMP/change.sh" "$TMP/checkout"
[ "$(cat "$TMP/tui.log")" = beta ]
[ "$(cat "$TMP/beta-calls.log")" = "0 0 0 0" ]

# Cancelar não grava e não executa efeitos colaterais.
rm -f "$TMP/cancel.log"
printf '0\n' | TUI_LOG="$TMP/cancel.log" CALL_LOG="$TMP/cancel-calls.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; CALL_LOG="$CALL_LOG"; change_channel_menu "$2"; printf "%s %s %s %s\n" "$install_calls" "$update_calls" "$build_calls" "$inject_calls" > "$CALL_LOG"' sh "$TMP/change.sh" "$TMP/checkout"
[ ! -e "$TMP/cancel.log" ]
[ "$(cat "$TMP/cancel-calls.log")" = "0 0 0 0" ]

# Sem checkout, a opção informa o próximo passo e não grava configuração ambígua.
rm -f "$TMP/no-checkout.log"
TUI_LOG="$TMP/no-checkout.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; change_channel_menu ""' sh "$TMP/change.sh"
[ ! -e "$TMP/no-checkout.log" ]

# Flag explícita vence o submenu sem alterar a preferência.
printf 'stable\n' > "$TMP/explicit.log"
TUI_LOG="$TMP/explicit.log" sh -c '. "$1"; TUI_LOG="$TUI_LOG"; CHANNEL_EXPLICIT=1; CHANNEL=beta; change_channel_menu "$2"' sh "$TMP/change.sh" "$TMP/checkout"
[ "$(cat "$TMP/explicit.log")" = stable ]

# --yes não abre prompt; sem preferência começa em stable e persiste esse valor.
rm -f "$TMP/yes.log"
TUI_LOG="$TMP/yes.log" ASSUME_YES=1 sh -c '. "$1"; TUI_LOG="$TUI_LOG"; ASSUME_YES=1; change_channel_menu "$2"' sh "$TMP/change.sh" "$TMP/checkout"
[ "$(cat "$TMP/yes.log")" = stable ]

# Exercita a função real de merge: preserva autoUpdate, outros plugins e JSON inválido.
awk '/^persist_channel\(\) \{/,/^show_status\(\) \{/' "$SH" | sed '$d' > "$TMP/persist.sh"
cat >> "$TMP/persist.sh" <<'EOF'
mod_settings_file() { printf '%s\n' "$SETTINGS_FILE"; }
warn() { :; }
EOF
printf '%s\n' '{"autoUpdate":false,"other":{"keep":true},"plugins":{"Other":{"enabled":true}}}' > "$TMP/settings.json"
SETTINGS_FILE="$TMP/settings.json" sh -c '. "$1"; persist_channel "$2" beta' sh "$TMP/persist.sh" "$TMP/checkout"
node -e 'const s=require(process.argv[1]); if(s.autoUpdate!==false||!s.other.keep||!s.plugins.Other.enabled||s.plugins.GoLiveBypass.updateChannel!=="beta")process.exit(1)' "$TMP/settings.json"
printf '%s\n' '{invalid' > "$TMP/settings-invalid.json"
cp "$TMP/settings-invalid.json" "$TMP/settings-before.json"
SETTINGS_FILE="$TMP/settings-invalid.json" sh -c '. "$1"; persist_channel "$2" stable || true' sh "$TMP/persist.sh" "$TMP/checkout"
cmp "$TMP/settings-invalid.json" "$TMP/settings-before.json"

printf '%s\n' 'installer channel menu: ok'
