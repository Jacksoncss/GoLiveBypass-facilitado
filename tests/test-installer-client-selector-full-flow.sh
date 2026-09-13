#!/bin/sh
#
# Regressao END-TO-END do seletor de alvos no fluxo real do instalador Linux.
#
# Relato: "baixar e executar o installer da main em TUI nao deixa escolher qual cliente
# Discord instalar apesar de varios clientes". A cadeia completa:
#
#   main_menu -> do_install -> select_target -> selecionar_alvos_inject
#   -> escolher_alvos_inject -> tui_menu_multi
#
# dirige cada elo com stubs de disco/rede e verifica se o seletor aparece com TODOS os
# clientes detectados (oficiais + paralelos + flatpaks), tanto no caminho interativo
# quanto no menu principal e apos a escolha/criacao do checkout.
#
set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
INSTALLER="$REPO/installer/golivebypass-installer.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FUNCS="$TMP/funcs.sh"
awk '/^banner$/{exit} {print}' "$INSTALLER" > "$FUNCS"

cat >> "$FUNCS" <<EOF
SCRIPT_PATH="$INSTALLER"
SCRIPT_DIR="$(dirname "$INSTALLER")"
MODE="install"
MOD=""
SOURCE=""
PLUGIN_SOURCE=""
ASSUME_YES=0
REPORT_NO_AUTO=1
EOF

FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME/.config/discord/app-1.0.0/resources"
: > "$FAKE_HOME/.config/discord/app-1.0.0/resources/app.asar"
mkdir -p "$FAKE_HOME/.local/share/vesktop/resources"
: > "$FAKE_HOME/.local/share/vesktop/resources/app.asar"
mkdir -p "$FAKE_HOME/.local/share/legcord/resources"
: > "$FAKE_HOME/.local/share/legcord/resources/app.asar"
mkdir -p "$FAKE_HOME/.var/app/com.discordapp.DiscordCanary/config/discordcanary/app-1.0.0/resources"
: > "$FAKE_HOME/.var/app/com.discordapp.DiscordCanary/config/discordcanary/app-1.0.0/resources/app.asar"
mkdir -p "$FAKE_HOME/.local/share/flatpak/app/org.equicord.equibop/current/active/files/bin/equibop/resources"
: > "$FAKE_HOME/.local/share/flatpak/app/org.equicord.equibop/current/active/files/bin/equibop/resources/app.asar"

CHECKOUT="$TMP/Equicord"
mkdir -p "$CHECKOUT/src/userplugins"
printf '%s\n' '{ "name": "equicord", "version": "1.0.0" }' > "$CHECKOUT/package.json"

export HOME="$FAKE_HOME"
export XDG_CONFIG_HOME="$FAKE_HOME/.config"
export XDG_DATA_HOME="$FAKE_HOME/.local/share"

# Carrega funcoes do instalador.
# shellcheck disable=SC1091
. "$FUNCS"

# Contadores e vereditos DEPOIS de carregar as funcoes: o instalador define `ok`, e definir
# os nossos antes do `.` deixava `ok` sombreado pela versao do instalador -- PASS nunca
# subia e o resumo sempre dizia "0 OK".
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  [OK] %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  [FAIL] %s\n' "$1"; }

# Registra a ORDEM real das etapas de do_install. Vai para arquivo porque cada elo roda em
# subshell ($(...)) e variaveis nao sobreviveriam.
ORDER="$TMP/order.log"
mark() { printf '%s\n' "$1" >> "$ORDER"; }

# Stubs: ferramentas externas e elos que precisam de disco/rede/node.
have() { return 1; }
git() { return 0; }
pnpm() { return 0; }
node() { case "$*" in *"require(process.argv[1]).name"*) printf 'equicord\n';; *) return 0;; esac; }
flatpak() { return 0; }
pgrep() { return 1; }
readlink() { printf '%s\n' "${2:-$1}"; }
injected_path() { return 1; }
# No-ops para elos que nao estamos testando (toolchain/build/inject), mas registrando a ordem:
# o que importa aqui e que o selo do seletor venha ANTES destes.
ensure_toolchain() { mark ensure_toolchain; return 0; }
install_plugin_source() { mark install_plugin_source; return 0; }
build_mod() { mark build_mod; return 0; }
injetar_alvos() { mark injetar_alvos; return 0; }
set_plugin_settings() { return 0; }
start_discord() { return 0; }
wait_discord_exit() { return 0; }
tui_menu() { printf '1\n'; }
tui_select() { tui_menu "$@"; }
tui_confirm() { return 0; }
tui_is_interactive() { return 0; }
# Registra em arquivo para sobreviver a subshell.
tui_menu_multi() {
    mark seletor
    printf '%s\n' "$1" > "$TMP/sel_titulo.txt"
    shift; printf '%s\n' "$#" > "$TMP/sel_itens.txt"
    printf '%s\n' "$*" > "$TMP/sel_lista.txt"
    local i out=""; i=1; while [ "$i" -le "$#" ]; do out="$out $i"; i=$((i+1)); done
    printf '%s\n' "$out"
}

echo "=== 1. Fluxo completo: do_install -> seletor (apos escolha do checkout) ==="
: > "$ORDER"
resp="$(do_install "$CHECKOUT" 2>/dev/null || true)"
sel_itens="$(cat "$TMP/sel_itens.txt" 2>/dev/null || echo 0)"
sel_titulo="$(cat "$TMP/sel_titulo.txt" 2>/dev/null || echo '')"
sel_lista="$(cat "$TMP/sel_lista.txt" 2>/dev/null || echo '')"
echo "   seletor titulo: $sel_titulo"
echo "   seletor itens:  $sel_itens"
[ "$sel_itens" -ge 5 ] && ok "do_install mostrou seletor com 5 clientes (oficiais+paralelos+flatpak)" \
                       || bad "do_install nao mostrou seletor ($sel_itens itens)"
case "$sel_lista" in *Vesktop*) ok "Vesktop presente" ;; *) bad "Vesktop ausente" ;; esac
case "$sel_lista" in *Legcord*) ok "Legcord presente" ;; *) bad "Legcord ausente" ;; esac
case "$sel_lista" in *Canary*) ok "Canary presente" ;; *) bad "Canary ausente" ;; esac
case "$sel_lista" in *Equibop*) ok "Equibop (flatpak) presente" ;; *) bad "Equibop (flatpak) ausente" ;; esac

# A pergunta de alvos tem de vir ANTES de qualquer mutacao: a correcao de UX move o
# selecionar_alvos_inject para logo apos select_target, antes de toolchain/plugin/build.
pos() { awk -v k="$1" '$0==k{print NR; exit}' "$ORDER" 2>/dev/null; }
sel_pos="$(pos seletor)"; tool_pos="$(pos ensure_toolchain)"
plug_pos="$(pos install_plugin_source)"; build_pos="$(pos build_mod)"
[ -n "$sel_pos" ] && ok "seletor rodou dentro de do_install" || bad "seletor nao rodou em do_install"
if [ -n "$sel_pos" ] && [ -n "$tool_pos" ] && [ -n "$plug_pos" ] && [ -n "$build_pos" ] \
   && [ "$sel_pos" -lt "$tool_pos" ] && [ "$sel_pos" -lt "$plug_pos" ] && [ "$sel_pos" -lt "$build_pos" ]; then
    ok "seletor veio ANTES de toolchain/plugin/build"
else
    bad "ordem errada (seletor=$sel_pos toolchain=$tool_pos plugin=$plug_pos build=$build_pos)"
fi
[ "$(awk '$0=="seletor"{n++} END{print n+0}' "$ORDER")" = "1" ] \
    && ok "seletor chamado exatamente uma vez" || bad "seletor nao foi chamado uma unica vez"

echo ""
echo "=== 2. Fluxo pos-criacao: install_mod + seletor ==="
tui_menu() {
    if [ "${CALLED:-0}" = "0" ]; then CALLED=1; printf '2\n'; else printf '1\n'; fi
}
CALLED=0
install_mod() {
    local target="$TMP/Vencord"
    mkdir -p "$target/src/userplugins"
    printf '%s\n' '{ "name": "vencord", "version": "1.0.0" }' > "$target/package.json"
    printf '%s\n' "$target"
}
: > "$TMP/sel_itens.txt"
resp2="$(do_install "" 2>/dev/null || true)"
sel_itens2="$(cat "$TMP/sel_itens.txt" 2>/dev/null || echo 0)"
[ "$sel_itens2" -ge 5 ] && ok "fluxo pos-criacao mostrou seletor com 5 clientes" \
                        || bad "fluxo pos-criacao nao mostrou seletor ($sel_itens2)"

echo ""
echo "=== 3. ASSUME_YES=1: seletor NAO mostra, oficiais vao para injecao ==="
ASSUME_YES=1
: > "$TMP/sel_titulo.txt"
resp3="$(selecionar_alvos_inject "$CHECKOUT")"
case "$resp3" in *"O|"*) ok "assume-yes devolve oficial para injecao" ;; *) bad "assume-yes nao devolveu oficial: [$resp3]" ;; esac
sel_titulo3="$(cat "$TMP/sel_titulo.txt" 2>/dev/null || echo '')"
[ -z "$sel_titulo3" ] && ok "assume-yes nao abriu seletor (correto)" \
                    || bad "assume-yes abriu seletor indevidamente"

echo ""
echo "=== 4. Esc no seletor cancela sem toolchain/plugin/build/injecao ==="
# Reverte o estado das secoes anteriores e faz o seletor devolver "0" (Esc/cancelar).
ASSUME_YES=0
CALLED=0
tui_menu() { printf '1\n'; }
tui_menu_multi() { mark seletor; printf '0\n'; }
: > "$ORDER"
: > "$TMP/sel_itens.txt"
# O cancelamento do Esc e um `exit 1` dentro de $(selecionar_alvos_inject), que o
# `set -eu` do instalador transforma na saida do do_install -- exatamente como no
# despacho real (`install) do_install ... ;;`), onde do_install NAO esta num `if`.
# Por isso rodamos num subshell com `set -e` e capturamos o codigo de saida: um `if
# do_install` desligaria o errexit e mascararia o cancelamento.
set +e
( set -e; do_install "$CHECKOUT" ) >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] && ok "Esc no seletor cancelou do_install (rc=$rc)" \
                || bad "Esc no seletor NAO cancelou do_install (rc=$rc)"
[ -n "$(pos seletor)" ] && ok "o seletor chegou a aparecer (cancelamento foi na pergunta)" \
                        || bad "o seletor nem apareceu; o cancelamento nao veio da pergunta"
if [ -n "$(pos ensure_toolchain)$(pos install_plugin_source)$(pos build_mod)$(pos injetar_alvos)" ]; then
    bad "cancelou mas rodou etapa de mutacao: [$(tr '\n' ' ' < "$ORDER")]"
else
    ok "cancelou sem instalar dependencias, compilar o plugin nem injetar"
fi

echo ""
echo "=== Resumo: $PASS OK, $FAIL falhas ==="
[ "$FAIL" -eq 0 ]
