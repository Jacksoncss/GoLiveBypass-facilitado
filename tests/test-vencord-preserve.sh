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
# Extrai as funcoes ate a chamada de banner(), sem o laco de argumentos top-level (que nao
# pode rodar ao sourcear). Por conteudo, e nao por numero de linha fixo: o intervalo por
# numero quebrava a cada mudanca de tamanho antes do banner.
awk -v end="$((BANNER_LINE - 1))" '
    NR < 68 { next }
    NR > end { next }
    /^while \[ \$# -gt 0 \]; do$/ { skip = 1; next }
    skip && /^done$/ { skip = 0; next }
    skip { next }
    { print }
' "$REPO/installer/golivebypass-installer.sh" > "$HARNESS"

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
# O instalador também define `ok`; reinstalar o contador depois do source evita que o
# resumo fique em zero mesmo quando as asserções passam.
ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
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

printf '\n== 5. Cliente paralelo não bloqueia checkout escolhido ==\n'
MIXED_HOME="$TMP/home-mixed"
OFFICIAL="$MIXED_HOME/.config/discord/app-1.0.0/resources"
PARALLEL="$MIXED_HOME/.local/share/equibop/resources"
ROOT="$TMP/Equicord-mixed"
mkdir -p "$OFFICIAL/app" "$PARALLEL/app" "$ROOT/src/utils"
printf 'official-original\n' > "$OFFICIAL/app.asar"
printf 'require("%s/Equibop/dist/desktop")\n' "$TMP" > "$PARALLEL/app/index.js"
printf '{"name":"equicord"}\n' > "$ROOT/package.json"
printf types > "$ROOT/src/utils/types.ts"

# O cliente paralelo pode apontar para outro build, mas isso não é conflito do
# Discord oficial: o patch direto tem uma guarda própria em patch_parallel_one().
discord_resources() { printf '%s\n' "$OFFICIAL" "$PARALLEL"; }
select_target() { printf '%s\n' "$ROOT"; }
select_update_channel() { printf 'stable\n'; }
installer_log() { :; }
ensure_toolchain() { :; }
install_plugin_source() { :; }
build_mod() { :; }
selecionar_alvos_inject() { printf 'O|%s\n' "$OFFICIAL"; }
select_persistence() { return 0; }
alvos_ja_injetados() { return 0; }
stop_discord() { :; }
set_plugin_settings() { :; }
start_discord() { :; }
injected_flatpak_id() { return 1; }

if (do_install "$ROOT" >/dev/null 2>"$TMP/mixed-ok.err"); then
    ok 'Equibop paralelo não bloqueou checkout Equicord'
else
    bad 'Equibop paralelo bloqueou checkout Equicord'
fi

# A mesma guarda continua protegendo o Discord oficial contra trocar o mod.
printf 'require("%s/Vencord/dist/desktop")\n' "$TMP" > "$OFFICIAL/app/index.js"
if (do_install "$ROOT" >/dev/null 2>"$TMP/mixed-conflict.err"); then
    bad 'mod diferente no Discord oficial foi aceito'
else
    case "$(cat "$TMP/mixed-conflict.err")" in
        *Vencord*Equicord*|*Equicord*Vencord*) ok 'mod diferente no Discord oficial continua bloqueado' ;;
        *) bad 'bloqueio do Discord oficial não cita os dois mods' ;;
    esac
fi

printf '\n== 6. Locks órfãos não impedem reabertura ==\n'
LOCK_HOME="$TMP/home-lock"
LOCK_DIR="$LOCK_HOME/.config/discord"
mkdir -p "$LOCK_DIR"
for item in SingletonCookie SingletonLock SingletonSocket; do
    ln -s "$TMP/missing-$item" "$LOCK_DIR/$item"
done
XDG_CONFIG_HOME="$LOCK_HOME/.config"
discord_running() { return 0; }
native_discord_running() { return 1; }
clear_stale_discord_locks
stale=0
for item in SingletonCookie SingletonLock SingletonSocket; do
    [ -L "$LOCK_DIR/$item" ] && stale=1
done
[ "$stale" -eq 0 ] \
    && ok 'locks órfãos foram removidos sem processo Discord' \
    || bad 'locks órfãos permaneceram sem processo Discord'

for item in SingletonCookie SingletonLock SingletonSocket; do
    ln -s "$TMP/live-$item" "$LOCK_DIR/$item"
done
native_discord_running() { return 0; }
clear_stale_discord_locks
alive=0
for item in SingletonCookie SingletonLock SingletonSocket; do
    [ -L "$LOCK_DIR/$item" ] || alive=1
done
[ "$alive" -eq 0 ] \
    && ok 'locks foram preservados enquanto havia processo Discord' \
    || bad 'locks ativos foram removidos indevidamente'

printf '\n== Resultado: %s ok, %s falhas ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
