#!/bin/sh
#
# Regressao do log LOCAL dos instaladores (escopo B: observabilidade local/manual, sem
# telemetria remota).
#
# Cobre, para o instalador .sh (execucao real das funcoes extraidas) e para o .ps1
# (conferencia estatica, porque o CI Linux nao tem pwsh):
#   1. installer.log local em JSONL com ts/nivel/componente/evento/fase e data allowlisted;
#   2. redaction fail-closed (chave proibida vira <redacted>, caminho pessoal vira <path>,
#      chave desconhecida e descartada);
#   3. limite/rotacao de 256 KiB mantendo linhas JSONL completas;
#   4. ausencia de POST/token/payload legado includeLogs (e nenhuma chamada de curl/wget);
#   5. #293 distinguivel: mod detectado sem checkout => checkout_rejected por codigo,
#      gate preservado (nao substitui app.asar) e falha registrada.
#
# Uso:
#   ./tests/test-installer-log.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
SH_INSTALLER="$REPO/installer/golivebypass-installer.sh"
PS_INSTALLER="$REPO/installer/GoLiveBypass-Installer.ps1"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Extrai a secao de log (funcoes + fail) por marcadores estaveis.
LOG_SECTION="$TMP/log-section.sh"
sed -n '/^# =* log local$/,/^# =* \/log local$/p' "$SH_INSTALLER" > "$LOG_SECTION"
if [ "$(grep -c '^installer_log()' "$LOG_SECTION")" -lt 1 ] || [ "$(grep -c '^fail()' "$LOG_SECTION")" -lt 1 ]; then
    printf '  [FAIL] nao consegui extrair a secao de log do instalador .sh\n'
    exit 1
fi

HARNESS="$TMP/harness.sh"
{
    cat "$LOG_SECTION"
    # awk extrai a funcao real (a mesma que o instalador chama no caminho da #293).
    awk '/^find_checkout\(\) \{/,/^\}$/' "$SH_INSTALLER"
    cat <<'EOF'
C_RED=""; C_DIM=""; C_OFF=""
SOURCE=""
# Stubs da descoberta: nenhum checkout provado em lugar nenhum, mas um mod ja injetado.
is_checkout() { return 1; }
checkout_from_injection() { return 1; }
checkout_on_disk() { return 1; }
installed_mod() { printf 'Equicord\n'; }
EOF
} > "$HARNESS"

# Fake curl/wget no PATH: nenhum POST pode acontecer em nenhum caminho do log.
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
for bin in curl wget; do
    printf '#!/bin/sh\ntouch "%s/called-%s"\nexit 1\n' "$TMP" "$bin" > "$FAKEBIN/$bin"
    chmod +x "$FAKEBIN/$bin"
done
PATH="$FAKEBIN:$PATH"
export PATH

printf '\n== 1. installer.log local em JSONL ==\n'

LOG_DIR="$TMP/data"
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log info installer.detect.started detect mode install
)

LOG_FILE="$LOG_DIR/installer.log"
if [ -f "$LOG_FILE" ]; then
    ok "cria installer.log no diretorio de dados"
else
    bad "nao criou $LOG_FILE"
fi

first="$(head -1 "$LOG_FILE" 2>/dev/null || true)"
case "$first" in
    *'"schema_version":1'*) ok "linha tem schema_version=1" ;; *) bad "sem schema_version: $first" ;;
esac
case "$first" in
    *'"level":"info"'*) ok "linha tem level" ;; *) bad "sem level: $first" ;;
esac
case "$first" in
    *'"component":"installer.linux"'*) ok "linha tem component do instalador Linux" ;; *) bad "sem component: $first" ;;
esac
case "$first" in
    *'"event":"installer.detect.started"'*) ok "linha tem event" ;; *) bad "sem event: $first" ;;
esac
case "$first" in
    *'"phase":"detect"'*) ok "linha tem phase" ;; *) bad "sem phase: $first" ;;
esac
case "$first" in
    *'"ts":"20'*) ok "linha tem timestamp ISO-8601" ;; *) bad "sem ts: $first" ;;
esac
if grep -qE '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"' "$LOG_FILE"; then
    ok "ts ISO-8601 UTC com milissegundos"
else
    bad "ts sem milissegundos: $first"
fi

printf '\n== 2. redaction fail-closed ==\n'
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.checkout_rejected detect reason "erro em /home/alice/Equicord/dist" token "abc123" senha "s3cr3t" campo_desconhecido "x"
)
last="$(tail -1 "$LOG_FILE")"
case "$last" in
    *'/home/alice'*|*abc123*|*s3cr3t*) bad "valor sensivel vazou para o log: $last" ;;
    *) ok "nenhum valor sensivel vaza" ;;
esac
case "$last" in
    *'<path>'*) ok "caminho absoluto vira <path>" ;;
    *) bad "caminho nao foi redigido: $last" ;;
esac
case "$last" in
    *'"token":"<redacted>"'*) ok "chave proibida token vira <redacted>" ;;
    *) bad "token nao foi redigido: $last" ;;
esac
case "$last" in
    *'"senha":"<redacted>"'*) ok "chave proibida senha vira <redacted>" ;;
    *) bad "senha nao foi redigida: $last" ;;
esac
case "$last" in
    *campo_desconhecido*) bad "chave desconhecida nao foi descartada: $last" ;;
    *) ok "chave desconhecida e descartada" ;;
esac

# UNC / caminho de rede e caminho POSIX fora de /home tambem sao redigidos.
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.checkout_rejected detect reason 'checkout em \\\\servidor\\Users\\alice\\Equicord e /opt/Equicord/dist'
)
last="$(tail -1 "$LOG_FILE")"
case "$last" in
    *'alice'*|*'/opt/'*|*'servidor'*) bad "caminho absoluto/UNC vazou: $last" ;;
    *) ok "caminho UNC e POSIX fora de /home sao redigidos" ;;
esac

# Cabecalho de autenticacao, URL com credencial e e-mail tambem sao redigidos.
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.probe probe reason 'Authorization: Bearer eyJhbGciOi.abc.def em https://alice:s3cr3t@example.test/x contato alice@example.com'
)
last="$(tail -1 "$LOG_FILE")"
for leak in 'eyJhbGciOi' 's3cr3t' 'alice@example.com' 'example.test/x'; do
    case "$last" in
        *"$leak"*) bad "vazou '$leak': $last" ;;
        *) ok "nao vaza '$leak'" ;;
    esac
done
case "$last" in
    *'Authorization=<redacted>'*|*'Authorization: <redacted>'*) ok "cabecalho Authorization consome a credencial" ;;
    *) bad "cabecalho Authorization nao foi redigido: $last" ;;
esac
case "$last" in
    *'<redacted-url>'*) ok "URL com credencial vira <redacted-url>" ;;
    *) bad "URL credenciada nao redigida: $last" ;;
esac
case "$last" in
    *'<email>'*) ok "e-mail vira <email>" ;;
    *) bad "e-mail nao redigido: $last" ;;
esac

printf '\n== 2b. falha de escrita nao quebra o fluxo ==\n'
# Diretorio impossivel (arquivo comum no lugar da pasta): installer_log tem que
# devolver sucesso e nao derrubar o instalador sob set -e.
: > "$TMP/not-a-dir"
rc_log=0
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$TMP/not-a-dir"
    . "$HARNESS"
    installer_log info installer.probe running count 1
    printf 'flow-continued\n'
) > "$TMP/writefail.out" 2>&1 || rc_log=$?
if [ "$rc_log" -eq 0 ] && grep -q 'flow-continued' "$TMP/writefail.out"; then
    ok "falha de escrita no log nao interrompe o fluxo"
else
    bad "falha de escrita quebrou o fluxo (rc=$rc_log): $(cat "$TMP/writefail.out")"
fi

printf '\n== 3. limite/rotacao ==\n'
LOG_DIR2="$TMP/data2"
mkdir -p "$LOG_DIR2"
# Semeia o arquivo acima do teto (linhas JSONL completas) e escreve UM evento: e o
# caminho exato de rotacao (limite atingido antes do append), sem custo de milhares
# de eventos.
awk 'BEGIN{ for (i=0;i<3000;i++) printf "{\"filler\":\"%0500d\"}\n", i }' > "$LOG_DIR2/installer.log"
seeded_size="$(wc -c < "$LOG_DIR2/installer.log" | tr -d ' ')"
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR2"
    . "$HARNESS"
    installer_log info installer.sentinel running count 1
)
LOG_FILE2="$LOG_DIR2/installer.log"
size="$(wc -c < "$LOG_FILE2" | tr -d ' ')"
if [ "$seeded_size" -gt 262144 ] && [ "$size" -le 262144 ]; then
    ok "rotacao trima para <=256 KiB (semeado=$seeded_size, final=$size)"
else
    bad "rotacao nao respeitou <=256 KiB (semeado=$seeded_size, final=$size)"
fi
if grep -qv '^{' "$LOG_FILE2"; then
    bad "rotacao deixou linha parcial no arquivo"
else
    ok "todas as linhas seguem JSONL completo (sem linha parcial)"
fi
if tail -1 "$LOG_FILE2" | grep -q 'installer.sentinel'; then
    ok "evento mais recente sobrevive a rotacao"
else
    bad "ultimo evento sumiu na rotacao"
fi

printf '\n== 4. ausencia de POST/token/payload legado ==\n'
if grep -Eq 'BUG_API|api\.skyplaceia|includeLogs|Invoke-SendAutoReport|Invoke-BugReport|-X POST|--post-data|report_send|report_error' "$SH_INSTALLER" "$PS_INSTALLER"; then
    bad "instalador ainda contem caminho de envio remoto"
else
    ok "nenhum token/API/POST/payload legado nos instaladores"
fi
if grep -q 'Invoke-SendAutoReport\|report_error\|report_send\|should_report' "$PS_INSTALLER" "$SH_INSTALLER"; then
    bad "restou chamada de relatorio automatico"
else
    ok "chamadas de relatorio automatico removidas"
fi

printf '\n== 5. #293 distinguivel (mod detectado sem checkout) ==\n'
LOG_DIR293="$TMP/data293"
rc=0
# shellcheck disable=SC1090
( set -eu; GLB_INSTALLER_LOG_DIR="$LOG_DIR293"; . "$HARNESS"; find_checkout ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "gate preservado: find_checkout falha (nao substitui app.asar)"
else
    bad "find_checkout devolveu rc=$rc (esperado 1)"
fi
LOG293="$LOG_DIR293/installer.log"
if grep -q '"event":"installer.checkout_rejected"' "$LOG293" && grep -q 'MOD_INSTALLED_WITHOUT_CHECKOUT' "$LOG293"; then
    ok "#293 distinguivel por codigo (MOD_INSTALLED_WITHOUT_CHECKOUT)"
else
    bad "log nao distingue o cenario da #293"
fi
if grep -q '"event":"installer.failed"' "$LOG293"; then
    ok "falha registrada em installer.failed"
else
    bad "falta installer.failed"
fi
if grep -q '/home/' "$LOG293"; then
    bad "log da #293 vazou caminho pessoal"
else
    ok "log da #293 sem caminho pessoal"
fi
if [ -f "$TMP/called-curl" ] || [ -f "$TMP/called-wget" ]; then
    bad "caminho de falha tentou POST"
else
    ok "caminho de falha nao tenta POST"
fi

printf '\n----------------------------------------\n'
printf '  %s: %s passaram, %s falharam\n' "$(basename "$0")" "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
