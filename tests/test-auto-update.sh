#!/bin/sh
#
# Testes do auto-update do instalador GoLiveBypass
#
# O auto-update adiciona 2 modos novos:
#   --check-update: so consulta o GitHub, nao mexe
#   --update: aplica update se houver versao nova
#
# Estes testes validam:
#   1. sintaxe do instalador (sh -n) em sh, dash, bash
#   2. modos novos reconhecidos pelo arg parsing
#   3. funcoes de auto-update definidas
#   4. manifest.json presente com version e updater
#   5. funcoes puras (compare_version, installed_plugin_version, backup_plugin)
#
# Uso: ./tests/test-auto-update.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

step() { printf '  [*] %s\n' "$1" >&2; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1" >&2; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1" >&2; }

# Cria um checkout fake do Vencord/Equicord com o plugin ja copiado
make_fake_checkout_with_plugin() {
    local root="$1"
    local version="${2:-1.1.8}"
    rm -rf "$root"
    mkdir -p "$root/src/userplugins/goLiveBypass"
    # Cria o manifest.json com a versao especificada
    cat > "$root/src/userplugins/goLiveBypass/manifest.json" <<EOF
{
  "name": "GoLiveBypass",
  "version": "$version",
  "updater": {
    "type": "github",
    "id": "bezumiya/GoLiveBypass",
    "assetName": "goLiveBypass-vencord.zip"
  }
}
EOF
    # Cria os outros arquivos do plugin
    echo "fake" > "$root/src/userplugins/goLiveBypass/index.tsx"
    echo "fake" > "$root/src/userplugins/goLiveBypass/native.ts"
}

# Extrai as funcoes de auto-update para um harness (sem main)
extract_update_functions() {
    awk '
        /^# Auto-update via GitHub Releases/ { found=1 }
        found && /^main_menu\(\) \{/ { exit }
        found { print }
    ' "$REPO/installer/golivebypass-installer.sh"
    # backup_plugin() usa PLUGIN_DIR_NAME (constante global) que nao esta no harness.
    printf "PLUGIN_DIR_NAME=\"goLiveBypass\"\n"
    printf "GITHUB_REPO=\"bezumiya/GoLiveBypass\"\n"
    printf "GITHUB_API=\"https://api.github.com/repos/bezumiya/GoLiveBypass\"\n"
    printf "GITHUB_UA=\"GoLiveBypass-Installer\"\n"
    printf 'have() { command -v "$1" >/dev/null 2>&1; }\n'
}

# --------------------------------------------------------------------------- 1. Sintaxe
echo
echo "== 1. Sintaxe do instalador com auto-update =="
for shell in sh dash bash; do
    if sh -c "command -v $shell" >/dev/null 2>&1; then
        if sh -c "$shell -n $REPO/installer/golivebypass-installer.sh" 2>/dev/null; then
            ok "sintaxe $shell (local)"
        else
            bad "sintaxe $shell (local)"
        fi
    fi
done

# --------------------------------------------------------------------------- 2. PLUGIN_FILES inclui manifest.json
echo
echo "== 2. PLUGIN_FILES inclui manifest.json =="
if grep -F "manifest.json" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "manifest.json listado em PLUGIN_FILES"
else
    bad "manifest.json NAO listado em PLUGIN_FILES"
fi

# --------------------------------------------------------------------------- 3. Modos novos reconhecidos
echo
echo "== 3. Modos --check-update e --update reconhecidos =="
if grep -F -e --check-update "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "modo --check-update presente"
else
    bad "modo --check-update NAO presente"
fi
if grep -F -e --update "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "modo --update presente"
else
    bad "modo --update NAO presente"
fi

# --------------------------------------------------------------------------- 4. Funcoes de auto-update definidas
echo
echo "== 4. Funcoes de auto-update definidas =="
for fn in github_latest_release github_plugin_release installed_plugin_version compare_version backup_plugin do_check_update do_update do_update_from_zip install_plugin_source copy_plugin_from_repo; do
    if grep -E "^${fn}\(\) \{" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
        ok "funcao $fn() definida"
    else
        bad "funcao $fn() NAO definida"
    fi
done

# --------------------------------------------------------------------------- 5. Manifest.json do plugin
echo
echo "== 5. goLiveBypass/manifest.json existe e tem campos =="
if [ -f "$REPO/goLiveBypass/manifest.json" ]; then
    ok "manifest.json presente"
    if grep -F -e '"version"' "$REPO/goLiveBypass/manifest.json" >/dev/null 2>&1; then
        ver=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$REPO/goLiveBypass/manifest.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
        ok "manifest.json tem version=$ver"
    else
        bad "manifest.json NAO tem campo version"
    fi
    if grep -F -e '"updater"' "$REPO/goLiveBypass/manifest.json" >/dev/null 2>&1; then
        ok "manifest.json tem updater"
    else
        bad "manifest.json NAO tem campo updater"
    fi
else
    bad "manifest.json NAO existe em goLiveBypass/"
fi

# --------------------------------------------------------------------------- 6. compare_version (semver)
echo
echo "== 6. compare_version (semver) =="
HARNESS="$(mktemp)"
extract_update_functions > "$HARNESS"

test_compare() {
    local installed="$1" latest="$2" expected="$3" desc="$4"
    local actual
    actual=$(sh -c ". $HARNESS; compare_version '$installed' '$latest'")
    if [ "$actual" = "$expected" ]; then
        ok "compare_version($installed, $latest) = $expected  [$desc]"
    else
        bad "compare_version($installed, $latest) = $actual (esperado $expected)  [$desc]"
    fi
}

test_compare "1.1.8" "1.1.8" "0"  "mesma versao"
test_compare "1.1.8" "1.1.9" "-1" "patch update"
test_compare "1.1.8" "1.2.0" "-1" "minor update"
test_compare "1.1.8" "2.0.0" "-1" "major update"
test_compare "1.1.9" "1.1.8" "1"  "downgrade"
test_compare "1.2.0" "1.1.8" "1"  "minor downgrade"
test_compare ""      "1.1.8" "-1" "instalado vazio"
test_compare "1.1.8" ""      "0"  "latest vazio"
test_compare "1.9.0" "1.10.0" "-1" "10 > 9 (sort -V)"
test_compare "1.10.0" "1.9.0" "1"  "1.10 > 1.9"
test_compare "v1.1.8" "1.1.8" "0"  "prefixo v no instalado"
test_compare "1.1.8" "v1.1.8" "0"  "prefixo v no latest"
test_compare "1.1.8" "v1.1.7" "1"  "downgrade com prefixo v"
test_compare "1.1.12-beta.13" "1.1.12" "-1" "beta -> release estavel correspondente (sort -V separando pre-release)"
test_compare "1.1.12" "1.1.12-beta.13" "1"  "release estavel nao faz downgrade para beta da mesma versao"
test_compare "1.1.12-beta.1" "1.1.12-beta.2" "-1" "beta 1 -> beta 2"
test_compare "1.1.12-beta.2" "1.1.12-beta.1" "1"  "beta 2 -> beta 1"

# --------------------------------------------------------------------------- 7. installed_plugin_version
echo
echo "== 7. installed_plugin_version =="

# Teste 1: manifest presente
TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "2.0.0"
ver=$(sh -c ". $HARNESS; installed_plugin_version '$TMP/repo/src/userplugins/goLiveBypass'")
if [ "$ver" = "2.0.0" ]; then
    ok "installed_plugin_version le manifest.json corretamente (2.0.0)"
else
    bad "installed_plugin_version: esperado 2.0.0, obtido '$ver'"
fi
rm -rf "$TMP"

# Teste 2: manifest ausente
TMP="$(mktemp -d)"
mkdir -p "$TMP/empty"
ver=$(sh -c ". $HARNESS; installed_plugin_version '$TMP/empty'")
if [ -z "$ver" ]; then
    ok "installed_plugin_version retorna vazio sem manifest"
else
    bad "installed_plugin_version: esperado vazio, obtido '$ver'"
fi
rm -rf "$TMP"

# --------------------------------------------------------------------------- 8. backup_plugin
echo
echo "== 8. backup_plugin =="

TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "1.1.8"
sh -c ". $HARNESS; backup_plugin '$TMP/repo'" 2>/dev/null
backup_dir="$TMP/repo/src/userplugins/.goLiveBypass.bak"
if [ -d "$backup_dir" ] && ls -1 "$backup_dir" 2>/dev/null | grep -q .; then
    ok "backup_plugin criou pasta de backup com timestamp"
else
    bad "backup_plugin NAO criou backup"
fi

# Teste de retencao: rodar 4x e ver que mantem so 3
TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "1.1.8"
backup_dir="$TMP/repo/src/userplugins/.goLiveBypass.bak"
sh -c "
. $HARNESS
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
" 2>/dev/null
count=$(ls -1 "$backup_dir" 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -le 3 ]; then
    ok "backup_plugin retem no maximo 3 backups (encontrou $count)"
else
    bad "backup_plugin retem $count backups (esperado <=3)"
fi
rm -rf "$TMP"

echo
echo "== 9. Canal do instalador e SemVer beta =="
if grep -F -- "--channel" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1 &&
   grep -F -- 'stable|beta' "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "parser aceita --channel stable|beta"
else
    bad "parser de --channel ausente"
fi
if grep -F -- "Stable e a opcao recomendada" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1 &&
   grep -F -- "Beta e opcional" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1 &&
   grep -F -- "ajuda a comunidade" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "mensagens de stable/beta sao encorajadoras e honestas"
else
    bad "mensagens de canal ausentes"
fi
if grep -E "installer\\.selected.*channel" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1 &&
   grep -E "installer\\.completed.*channel" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "eventos selected/completed incluem canal"
else
    bad "eventos selected/completed sem canal"
fi
if grep -F 'pode persistir o canal, sem baixar ZIP' "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1 &&
   grep -F 'pode persistir o canal, sem baixar ZIP' "$REPO/installer/GoLiveBypass-Installer.ps1" >/dev/null 2>&1; then
    ok "CheckUpdate documenta persistencia sem download"
else
    bad "documentacao CheckUpdate desatualizada"
fi
if [ "$(sh -c ". $HARNESS; compare_version 2.0.0-beta-9 2.0.0-beta-10")" = "-1" ] &&
   [ "$(sh -c ". $HARNESS; compare_version 2.0.0-beta-10 2.0.0-beta-11")" = "-1" ] &&
   [ "$(sh -c ". $HARNESS; compare_version 2.0.0-beta-11 2.0.0-beta-10")" = "1" ]; then
    ok "SemVer prova beta-9 < beta-10 < beta-11"
else
    bad "SemVer beta com dois digitos incorreto"
fi
FIXTURE="$(mktemp -d)"
cat > "$FIXTURE/releases.json" <<'EOF'
[
  {"draft":true,"prerelease":true,"tag_name":"v9.9.9-beta-99","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/draft"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/draft.sha"}]},
  {"draft":false,"prerelease":true,"tag_name":"v2.1.0-beta-9","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/b9"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/b9.sha"}]},
  {"draft":false,"prerelease":true,"tag_name":"v2.1.0-beta-10","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/b10"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/b10.sha"}]},
  {"draft":false,"prerelease":true,"tag_name":"v2.1.0-beta-11","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/b11"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/b11.sha"}]},
  {"draft":false,"prerelease":false,"tag_name":"v2.0.0","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/stable"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/stable.sha"}]},
  {"draft":false,"prerelease":false,"tag_name":"v2.2.0","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/no-sha"}]}
]
EOF
cat > "$FIXTURE/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$GLB_CURL_LOG"
cat "$GLB_FIXTURE"
EOF
chmod +x "$FIXTURE/curl"
stable_release=$(GLB_FIXTURE="$FIXTURE/releases.json" GLB_CURL_LOG="$FIXTURE/curl.log" PATH="$FIXTURE:$PATH" sh -c ". '$HARNESS'; github_release_candidates stable")
beta_release=$(GLB_FIXTURE="$FIXTURE/releases.json" GLB_CURL_LOG="$FIXTURE/curl.log" PATH="$FIXTURE:$PATH" sh -c ". '$HARNESS'; github_release_candidates beta")
if [ "$(printf '%s\n' "$stable_release" | sed -n '1p')" = "2.0.0" ]; then
    ok "stable filtra beta/draft/missing SHA e escolhe a maior stable"
else
    bad "selecao stable de release incorreta"
fi
if [ "$(printf '%s\n' "$beta_release" | sed -n '1p')" = "2.1.0-beta-11" ]; then
    ok "beta considera stable/prerelease e prova beta-9 < beta-10 < beta-11"
else
    bad "selecao beta ou ordem SemVer incorreta"
fi
if ! grep -F '/releases/latest' "$FIXTURE/curl.log" >/dev/null 2>&1; then ok "selecao de canal nao usa /releases/latest"; else bad "selecao usou endpoint latest"; fi
INITIAL_HARNESS="$FIXTURE/initial-install.sh"
{
    printf '%s\n' 'set -eu' 'PLUGIN_DIR_NAME=goLiveBypass' 'PLUGIN_SOURCE=""' "SCRIPT_DIR=\"$FIXTURE/empty\"" 'CHANNEL=beta'
    printf '%s\n' 'step() { :; }' 'fail() { printf "%s\n" "$1" >&2; return 1; }' 'copy_plugin_from_repo() { fail "unexpected local source"; }'
    printf '%s\n' 'github_plugin_release() { printf "%s\n" "2.1.0-beta-11" "https://fake/b11.zip" "https://fake/b11.sha" "1"; }'
    printf '%s\n' 'do_update_from_zip() { printf "%s\n" "$@" > "$1/initial-call"; }'
    sed -n '/^install_plugin_source() {/,/^}/p' "$REPO/installer/golivebypass-installer.sh"
} > "$INITIAL_HARNESS"
INITIAL_ROOT="$FIXTURE/initial-root"
mkdir -p "$INITIAL_ROOT"
sh -c '. "$1"; install_plugin_source "$2"' sh "$INITIAL_HARNESS" "$INITIAL_ROOT"
expected_initial=$(printf '%s\n' "$INITIAL_ROOT" "https://fake/b11.zip" "2.1.0-beta-11" "https://fake/b11.sha")
if [ "$(cat "$INITIAL_ROOT/initial-call")" = "$expected_initial" ]; then
    ok "instalacao inicial passa zip e SHA da mesma release"
else
    bad "instalacao inicial nao desempacota contrato da release"
fi
rm -rf "$FIXTURE"
rm -f "$HARNESS"
echo
echo "== 10. Flag/default noninteractive, merge e check sem download =="
RUNTIME="$(mktemp -d)"
mkdir -p "$RUNTIME/Equicord/src/utils" "$RUNTIME/Equicord/src/userplugins/goLiveBypass" "$RUNTIME/home/.config/Equicord/settings" "$RUNTIME/bin"
printf '{"name":"Equicord"}\n' > "$RUNTIME/Equicord/package.json"
: > "$RUNTIME/Equicord/src/utils/types.ts"
printf '{"version":"2.0.0-beta-9"}\n' > "$RUNTIME/Equicord/src/userplugins/goLiveBypass/manifest.json"
printf '{"autoUpdate":false,"keep":{"nested":true}}\n' > "$RUNTIME/home/.config/Equicord/settings/settings.json"
cat > "$RUNTIME/releases.json" <<'EOF'
[{"draft":false,"prerelease":false,"tag_name":"v2.0.0","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/stable"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/stable.sha"}]},{"draft":false,"prerelease":true,"tag_name":"v2.0.0-beta-10","assets":[{"name":"goLiveBypass-vencord.zip","browser_download_url":"https://fake/beta"},{"name":"goLiveBypass-vencord.zip.sha256","browser_download_url":"https://fake/beta.sha"}]}]
EOF
cat > "$RUNTIME/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$GLB_CURL_LOG"
cat "$GLB_FIXTURE"
EOF
chmod +x "$RUNTIME/bin/curl"
flag_out="$(GLB_FIXTURE="$RUNTIME/releases.json" GLB_CURL_LOG="$RUNTIME/curl.log" HOME="$RUNTIME/home" PATH="$RUNTIME/bin:$PATH" GLB_INSTALLER_LOG_DIR="$RUNTIME/log" sh "$REPO/installer/golivebypass-installer.sh" --check-update --source "$RUNTIME/Equicord" --channel beta --yes 2>/dev/null || true)"
if printf '%s\n' "$flag_out" | grep -F 'canal: beta' >/dev/null; then ok "flag --channel beta vence e -Yes nao bloqueia"; else bad "flag/default beta incorreto"; fi
if [ "$(wc -l < "$RUNTIME/curl.log" | tr -d ' ')" = "1" ] && ! grep -F 'plugin.zip' "$RUNTIME/curl.log" >/dev/null 2>&1; then ok "--check-update consulta API sem download do zip"; else bad "--check-update baixou alem da API"; fi
if node -e 'const s=require(process.argv[1]); if(s.autoUpdate!==false||s.keep.nested!==true||s.plugins.GoLiveBypass.updateChannel!=="beta")process.exit(1)' "$RUNTIME/home/.config/Equicord/settings/settings.json"; then ok "persistencia faz merge preservando autoUpdate e demais chaves"; else bad "persistencia nao preservou configuracoes"; fi
rm -f "$RUNTIME/home/.config/Equicord/settings/settings.json"
default_out="$(GLB_FIXTURE="$RUNTIME/releases.json" GLB_CURL_LOG="$RUNTIME/curl-default.log" HOME="$RUNTIME/home" PATH="$RUNTIME/bin:$PATH" GLB_INSTALLER_LOG_DIR="$RUNTIME/log-default" sh "$REPO/installer/golivebypass-installer.sh" --check-update --source "$RUNTIME/Equicord" --yes 2>/dev/null || true)"
if printf '%s\n' "$default_out" | grep -F 'canal: stable' >/dev/null; then ok "modo noninteractive sem flag usa stable por padrao"; else bad "default stable noninteractive incorreto"; fi
rm -rf "$RUNTIME"
# --------------------------------------------------------------------------- 9. Uso documentado
echo
echo "== 9. Documentacao do auto-update =="
if head -30 "$REPO/installer/golivebypass-installer.sh" | grep -F -e --check-update >/dev/null 2>&1; then
    ok "uso do instalador menciona --check-update"
else
    bad "uso do instalador NAO menciona --check-update"
fi
if head -30 "$REPO/installer/golivebypass-installer.sh" | grep -F -e --update >/dev/null 2>&1; then
    ok "uso do instalador menciona --update"
else
    bad "uso do instalador NAO menciona --update"
fi

# ---------------------------------------------------------------------------
echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
