#!/bin/sh
# Regressao do instalador: toda fonte importada precisa chegar ao mesmo userplugin antes do build.
set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TMP="$(mktemp -d -t golive-plugin-copy.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PLUGIN_FILES="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/plugin-log.ts goLiveBypass/bug-report.ts goLiveBypass/update-channel.ts goLiveBypass/update-security.ts goLiveBypass/stability.ts goLiveBypass/vpn-controller.ts goLiveBypass/vpn-proton.ts goLiveBypass/vpn-types.ts goLiveBypass/vpn-snapshot.ts goLiveBypass/vpn-snapshot-worker.ts goLiveBypass/vpn-windows.ts goLiveBypass/vpn-linux.ts goLiveBypass/manifest.json"
export PLUGIN_FILES

# Carrega somente as funcoes puras do instalador; o CLI principal nunca roda no harness.
FUNCTIONS="$TMP/functions.sh"
awk '/^validate_plugin_source_tree\(\)/,/^# De onde vem o plugin instalado/ { print }' \
    "$REPO/installer/golivebypass-installer.sh" > "$FUNCTIONS"
awk '/^build_mod\(\)/,/^remove_plugin_source\(\)/ {
    if ($0 !~ /^remove_plugin_source\(\)/) print
}' "$REPO/installer/golivebypass-installer.sh" >> "$FUNCTIONS"
cat >> "$FUNCTIONS" <<'EOF'
PLUGIN_DIR_NAME="goLiveBypass"
step() { :; }
warn() { :; }
installer_log() { :; }
checkout_mod() { printf '%s\n' Equicord; }
fail() { printf '%s\n' "$*" >&2; exit 97; }
EOF

make_source() {
    source="$1"
    mkdir -p "$source"
    for file in $PLUGIN_FILES; do
        printf 'module %s\n' "$(basename "$file")" > "$source/$(basename "$file")"
    done
}

SOURCE="$TMP/source"
ROOT="$TMP/Equicord"
make_source "$SOURCE"
mkdir -p "$ROOT/node_modules"

# O build fake falha se qualquer required file nao estiver no mesmo diretorio do plugin.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'EOF'
#!/bin/sh
set -eu
[ "${1:-}" = build ] || exit 2
for file in $PLUGIN_FILES; do
    test -s "$ROOT/src/userplugins/$PLUGIN_DIR_NAME/$(basename "$file")" || {
        printf 'missing %s\n' "$file" >&2
        exit 3
    }
done
printf 'fake pnpm build ok\n'
EOF
chmod +x "$TMP/bin/pnpm"

# Copia completa e build: cobre estabilidade.ts e vpn-types.ts, os imports do relato.
ROOT="$ROOT" PLUGIN_DIR_NAME=goLiveBypass PLUGIN_SOURCE="$SOURCE" \
    PATH="$TMP/bin:$PATH" sh -eu -c ". '$FUNCTIONS'; copy_plugin_from_repo '$ROOT'; build_mod '$ROOT'"

for file in $PLUGIN_FILES; do
    test -s "$ROOT/src/userplugins/goLiveBypass/$(basename "$file")"
done
printf '%s\n' 'ok - copia completa atende o build fake'

# Uma fonte local incompleta deve falhar explicitamente, mesmo quando o destino ja tem um
# modulo stale com o mesmo nome; nunca aceitar uma arvore parcial para compilar.
INCOMPLETE="$TMP/incomplete"
make_source "$INCOMPLETE"
rm -f "$INCOMPLETE/stability.ts"
STALE_ROOT="$TMP/Stale"
mkdir -p "$STALE_ROOT/src/userplugins/goLiveBypass"
printf 'stale\n' > "$STALE_ROOT/src/userplugins/goLiveBypass/stability.ts"
if ROOT="$STALE_ROOT" PLUGIN_DIR_NAME=goLiveBypass PLUGIN_SOURCE="$INCOMPLETE" \
    sh -eu -c ". '$FUNCTIONS'; copy_plugin_from_repo '$STALE_ROOT'" >"$TMP/fail.out" 2>&1; then
    printf '%s\n' 'fail - arvore incompleta foi aceita' >&2
    exit 1
fi
grep -F 'Nao achei stability.ts' "$TMP/fail.out" >/dev/null
printf '%s\n' 'ok - copia incompleta falha antes do build'
