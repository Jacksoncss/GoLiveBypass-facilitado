#!/bin/sh
# Regressão comportamental: o instalador nunca deve substituir ou desfazer um
# patch Vencord/Equicord já existente quando não consegue compor com ele.
set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Carrega somente as funções do instalador, sem executar o main nem fazer rede.
HARNESS="$TMP/functions.sh"
BANNER_LINE="$(awk '/^banner$/{print NR; exit}' "$REPO/installer/golivebypass-installer.sh")"
{
    sed -n '68,690p' "$REPO/installer/golivebypass-installer.sh"
    sed -n "710,$((BANNER_LINE - 1))p" "$REPO/installer/golivebypass-installer.sh"
} > "$HARNESS"

new_tree() {
    TEST_HOME="$TMP/home-$1"
    export HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config"
    mkdir -p "$HOME/.config/discord/app-1.0.0/resources"
    RES="$HOME/.config/discord/app-1.0.0/resources"
    printf 'require("%s/VencordData/dist/patcher.js")\n' "$TMP" > "$RES/app.asar"
    printf 'stock-discord\n' > "$RES/_app.asar"
    mkdir -p "$TMP/VencordData/dist"
}

printf '\n== 1. Patch existente sem checkout fonte ==\n'
new_tree no-source
REPORT_NO_AUTO=1 SCRIPT_PATH="$REPO/installer/golivebypass-installer.sh" SCRIPT_DIR="$REPO/installer" PLUGIN_DIR_NAME=goLiveBypass ASSUME_YES=1 . "$HARNESS"
discord_resources() { printf '%s\n' "$RES"; }
before_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
before_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
if (find_checkout >/dev/null 2>"$TMP/no-source.err"); then
    bad 'patch Vencord sem checkout foi aceito'
else
    after_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
    after_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
    [ "$before_app" = "$after_app" ] && [ "$before_backup" = "$after_backup" ] \
        && ok 'patch Vencord e backup permaneceram intactos' \
        || bad 'árvore mudou ao recusar patch sem checkout'
fi

printf '\n== 2. Patch direto não substitui cliente paralelo já modificado ==\n'
new_tree parallel
ROOT="$TMP/Equicord"
mkdir -p "$ROOT/src/utils" "$ROOT/dist"
printf '{"name":"equicord"}\n' > "$ROOT/package.json"
printf types > "$ROOT/src/utils/types.ts"
printf equicord-build > "$ROOT/dist/equibop.asar"
PARALLEL="$HOME/.local/share/vesktop/resources"
mkdir -p "$PARALLEL"
printf 'require("%s/VencordData/dist/patcher.js")\n' "$TMP" > "$PARALLEL/app.asar"
printf 'parallel-original\n' > "$PARALLEL/_app.asar"
before_app="$(sha256sum "$PARALLEL/app.asar" | cut -d' ' -f1)"
before_backup="$(sha256sum "$PARALLEL/_app.asar" | cut -d' ' -f1)"
if patch_parallel_one "$ROOT" "$PARALLEL" >/dev/null 2>"$TMP/parallel.err"; then
    bad 'cliente paralelo já modificado foi sobrescrito'
else
    after_app="$(sha256sum "$PARALLEL/app.asar" | cut -d' ' -f1)"
    after_backup="$(sha256sum "$PARALLEL/_app.asar" | cut -d' ' -f1)"
    [ "$before_app" = "$after_app" ] && [ "$before_backup" = "$after_backup" ] \
        && ok 'app.asar e _app.asar do paralelo permaneceram intactos' \
        || bad 'cliente paralelo mudou ao recusar patch'
fi

printf '\n== 3. Remoção temporária remove só o plugin ==\n'
new_tree cleanup
ROOT="$TMP/Vencord"
mkdir -p "$ROOT/src/userplugins/goLiveBypass" "$ROOT/src/utils"
printf '{"name":"vencord"}\n' > "$ROOT/package.json"
printf types > "$ROOT/src/utils/types.ts"
printf plugin > "$ROOT/src/userplugins/goLiveBypass/index.tsx"
mkdir -p "$ROOT/dist/desktop"
printf 'require("./goLiveBypass.js")\n' > "$ROOT/dist/desktop/index.js"
printf 'console.log("vencord-plugin-loaded")\n' > "$ROOT/dist/desktop/goLiveBypass.js"
node "$ROOT/dist/desktop/index.js" | grep -qx 'vencord-plugin-loaded' \
    && ok 'loader Vencord preservado continua carregando o plugin' \
    || bad 'loader Vencord não carregou o plugin'
printf 'build-before\n' > "$ROOT/build.log"
pnpm() { printf '%s\n' "$*" >> "$ROOT/build.log"; }
before_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
before_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
remove_plugin_source "$ROOT"
after_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
after_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
[ ! -e "$ROOT/src/userplugins/goLiveBypass" ] && [ "$before_app" = "$after_app" ] && [ "$before_backup" = "$after_backup" ] \
    && grep -qx build "$ROOT/build.log" \
    && ok 'remoção temporária apagou só GoLiveBypass e recompilou o mod' \
    || bad 'remoção temporária alterou o patch ou não recompilou'
printf '\n== 4. Restaurar tudo não desfaz o mod ==\n'
new_tree restore
ROOT="$TMP/Vencord-restore"
mkdir -p "$ROOT/src/userplugins/goLiveBypass" "$ROOT/src/utils"
printf '{"name":"vencord"}\n' > "$ROOT/package.json"
printf types > "$ROOT/src/utils/types.ts"
printf plugin > "$ROOT/src/userplugins/goLiveBypass/index.tsx"
printf 'build-before\n' > "$ROOT/build.log"
pnpm() { printf '%s\n' "$*" >> "$ROOT/build.log"; }
find_checkout() { printf '%s\n' "$ROOT"; }
stop_discord() { :; }
remove_tor() { :; }
before_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
before_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
do_restore_everything >/dev/null 2>"$TMP/restore.err"
after_app="$(sha256sum "$RES/app.asar" | cut -d' ' -f1)"
after_backup="$(sha256sum "$RES/_app.asar" | cut -d' ' -f1)"
if [ ! -e "$ROOT/src/userplugins/goLiveBypass" ] && [ "$before_app" = "$after_app" ] && [ "$before_backup" = "$after_backup" ] && ! grep -qx 'uninject' "$ROOT/build.log"; then
    ok 'Restaurar tudo remove só o plugin e preserva o patch'
else
    bad 'Restaurar tudo desfez ou alterou o patch do mod'
fi

printf '\n== Resultado: %s ok, %s falhas ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
