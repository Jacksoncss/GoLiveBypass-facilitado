# PowerShell test script for error handling and null-safety validation
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

$installerPath = Join-Path $repoRoot 'installer\GoLiveBypass-Installer.ps1'
$standalonePath = Join-Path $repoRoot 'standalone\GoLiveBypass-Standalone.ps1'

# Garante UTF-8 com BOM para compatibilidade com o parser do Windows PowerShell 5.1
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
foreach ($f in @($installerPath, $standalonePath)) {
    if (Test-Path -LiteralPath $f) {
        $text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText($f, $text, $utf8Bom)
    }
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 1. Validando Sintaxe dos Scripts PowerShell" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

function Test-ScriptSyntax($path) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        Write-Host "  [FAIL] $path possui erros de sintaxe:" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "    Linha $($_.Extent.StartLineNumber): $($_.Message)" }
        return $false
    }
    Write-Host "  [OK] $($path | Split-Path -Leaf) - Sintaxe valida" -ForegroundColor Green
    return $true
}

$syntaxOk1 = Test-ScriptSyntax $installerPath
$syntaxOk2 = Test-ScriptSyntax $standalonePath
if (-not $syntaxOk1 -or -not $syntaxOk2) {
    exit 1
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 2. Carregando e Testando Funcoes" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# Carrega funcoes do instalador
$installerContent = Get-Content -LiteralPath $installerPath -Raw
$idx = $installerContent.LastIndexOf("Show-Banner")
$truncatedInstaller = $installerContent.Substring(0, $idx)
$tempInstaller = Join-Path ([System.IO.Path]::GetTempPath()) "test-temp-installer.ps1"
Set-Content -LiteralPath $tempInstaller -Value $truncatedInstaller -Encoding UTF8
. $tempInstaller

# Salva referencia para Test-ShouldReport do instalador
$installerShouldReport = ${function:Test-ShouldReport}
$installerWaitAntesDeFechar = ${function:Wait-AntesDeFechar}
$installerTestJanela = ${function:Test-JanelaTransitoria}

# Carrega funcoes do standalone
$standaloneContent = Get-Content -LiteralPath $standalonePath -Raw
$idx2 = $standaloneContent.IndexOf("Write-Host ''`nWrite-Host '  GoLiveBypass standalone'")
if ($idx2 -lt 0) { $idx2 = $standaloneContent.IndexOf("Write-Host ''`r`nWrite-Host '  GoLiveBypass standalone'") }
$truncatedStandalone = $standaloneContent.Substring(0, $idx2)
$tempStandalone = Join-Path ([System.IO.Path]::GetTempPath()) "test-temp-standalone.ps1"
Set-Content -LiteralPath $tempStandalone -Value $truncatedStandalone -Encoding UTF8
. $tempStandalone

# O corpo principal do standalone começa antes de Get-InjectionState em algumas
# versões; carregue somente essa função quando o recorte seguro não a trouxe.
if (-not (Get-Command Get-InjectionState -ErrorAction SilentlyContinue)) {
    $stateStart = $standaloneContent.IndexOf('function Get-InjectionState')
    $stateEnd = $standaloneContent.IndexOf('$ParallelNames', $stateStart)
    if ($stateStart -lt 0 -or $stateEnd -le $stateStart) {
        throw 'Nao consegui carregar Get-InjectionState do standalone para o teste.'
    }
    . ([scriptblock]::Create($standaloneContent.Substring($stateStart, $stateEnd - $stateStart)))
}

$standaloneShouldReport = ${function:Test-ShouldReport}
$standaloneWaitAntesDeFechar = ${function:Wait-AntesDeFechar}
$standaloneTestJanela = ${function:Test-JanelaTransitoria}

$pass = 0
$fail = 0

function Assert-Equal($actual, $expected, $desc) {
    if ($actual -eq $expected) {
        $script:pass++
        Write-Host "  [OK] $desc (Resultado: $actual)" -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host "  [FAIL] $desc (Esperado: $expected, Obtido: $actual)" -ForegroundColor Red
    }
}

Write-Host "`n-- 2.1 Test-ShouldReport (Instalador e Standalone) --" -ForegroundColor Yellow

$testMessages = @(
    # Mensagens que NAO devem reportar (retornam $false)
    @{ Msg = "Não é possível associar o argumento ao parâmetro 'Path' porque ele é nulo."; Expected = $false; Desc = "PT-BR com acentos (erro da issue)" },
    @{ Msg = "Nao e possivel associar o argumento ao parametro 'Path' porque ele e nulo."; Expected = $false; Desc = "PT-BR sem acentos" },
    @{ Msg = "Não é possível associar o argumento ao parâmetro 'LiteralPath' porque ele é uma cadeia de caracteres vazia."; Expected = $false; Desc = "PT-BR cadeia de caracteres vazia" },
    @{ Msg = "Cannot bind argument to parameter 'Path' because it is null."; Expected = $false; Desc = "EN parameter is null" },
    @{ Msg = "Cannot bind argument to parameter 'Path' because it is an empty string."; Expected = $false; Desc = "EN parameter empty string" },
    @{ Msg = "A operacao foi cancelada pelo usuario."; Expected = $false; Desc = "Cancelado pelo usuario PT" },
    @{ Msg = "A operação foi cancelada pelo usuário."; Expected = $false; Desc = "Cancelado pelo usuário acentuado" },
    @{ Msg = "The operation was canceled by the user."; Expected = $false; Desc = "Canceled by user EN" },
    @{ Msg = "Illegal characters in path."; Expected = $false; Desc = "Illegal characters" },
    @{ Msg = "O Discord nao fechou. Feche pelo icone na bandeja e rode de novo."; Expected = $false; Desc = "Discord nao fechou" },
    @{ Msg = "Opcao desconhecida: --foo"; Expected = $false; Desc = "Opcao desconhecida" },
    @{ Msg = "git clone falhou"; Expected = $false; Desc = "git clone falhou" },
    
    # Mensagens que DEVEM reportar (retornam $true)
    @{ Msg = "NullReferenceException: Object reference not set to an instance of an object."; Expected = $true; Desc = "Excecao inesperada" },
    @{ Msg = "Erro desconhecido ao processar pacote asar."; Expected = $true; Desc = "Erro desconhecido" }
)

foreach ($t in $testMessages) {
    $resInst = & $installerShouldReport $t.Msg
    Assert-Equal $resInst $t.Expected "Installer Test-ShouldReport: $($t.Desc)"
    
    $resStand = & $standaloneShouldReport $t.Msg
    Assert-Equal $resStand $t.Expected "Standalone Test-ShouldReport: $($t.Desc)"
}

Write-Host "`n-- 2.2 Null/Empty Safety em Funcoes Auxiliares --" -ForegroundColor Yellow

# Test-DiscordResourcesReady
Assert-Equal (Test-DiscordResourcesReady $null) $false "Test-DiscordResourcesReady($null) retorna $false"
Assert-Equal (Test-DiscordResourcesReady "") $false "Test-DiscordResourcesReady('') retorna $false"

# Get-InjectedPath
Assert-Equal (Get-InjectedPath $null) $null "Get-InjectedPath($null) retorna $null"
Assert-Equal (Get-InjectedPath "") $null "Get-InjectedPath('') retorna $null"

# Test-InjectedFromCheckout
Assert-Equal (Test-InjectedFromCheckout $null) $false "Test-InjectedFromCheckout($null) retorna $false"
Assert-Equal (Test-InjectedFromCheckout "") $false "Test-InjectedFromCheckout('') retorna $false"

# Get-InstalledPluginVersion
Assert-Equal (Get-InstalledPluginVersion $null) $null "Get-InstalledPluginVersion($null) retorna $null"
Assert-Equal (Get-InstalledPluginVersion "") $null "Get-InstalledPluginVersion('') retorna $null"

# Backup-Plugin
try {
    Backup-Plugin $null
    Assert-Equal $true $true "Backup-Plugin($null) nao lanca excecao"
} catch {
    Assert-Equal $false $true "Backup-Plugin($null) lancou excecao: $($_.Exception.Message)"
}

# Save-Text
try {
    Save-Text $null "test content"
    Assert-Equal $true $true "Save-Text($null, ...) nao lanca excecao"
} catch {
    Assert-Equal $false $true "Save-Text($null, ...) lancou excecao: $($_.Exception.Message)"
}

# Get-InjectionState prioriza um WireSock já ativo mesmo sem resources.
$wiresockForState = Get-Service -Name 'wiresock-client-service' -ErrorAction SilentlyContinue
$expectedNullInjectionState = if ($wiresockForState -and $wiresockForState.Status -eq 'Running') { 'Nosso' } else { 'Vanilla' }
Assert-Equal (Get-InjectionState $null) $expectedNullInjectionState "Get-InjectionState($null) respeita o estado do WireSock"
Assert-Equal (Get-InjectionState "") $expectedNullInjectionState "Get-InjectionState('') respeita o estado do WireSock"

# Test-ModCheckout
Assert-Equal (Test-ModCheckout $null) $false "Test-ModCheckout($null) retorna $false"
Assert-Equal (Test-ModCheckout "") $false "Test-ModCheckout('') retorna $false"


Write-Host "`n-- 2.3 Get-EffectiveLocalApp / Get-ReportMeta (caminho 8.3, issue #94) --" -ForegroundColor Yellow

$origLocalAppData = $env:LOCALAPPDATA
try {
    # LOCALAPPDATA apontando para caminho que NAO existe (forma 8.3 orfa): tem que
    # cair para o fallback que resolve, nunca devolver o caminho quebrado.
    $env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) "nao-existe-$(Get-Random)"
    $fallback = Get-EffectiveLocalApp
    Assert-Equal (Test-Path -LiteralPath $fallback) $true "Get-EffectiveLocalApp cai para fallback resolvivel com LOCALAPPDATA orfao"
    Assert-Equal ($fallback -eq $env:LOCALAPPDATA) $false "Get-EffectiveLocalApp nao devolve o caminho orfao"

    # LOCALAPPDATA valido: devolvido sem mudanca.
    $valido = [System.IO.Path]::GetTempPath().TrimEnd('\', '/')
    $env:LOCALAPPDATA = $valido
    Assert-Equal (Get-EffectiveLocalApp) $valido "Get-EffectiveLocalApp devolve LOCALAPPDATA valido sem alteracao"
} finally {
    $env:LOCALAPPDATA = $origLocalAppData
}

try {
    # Get-ReportMeta: flag caminho_8_3 marca variaveis gravadas na forma curta
    # (ex. C:\Users\CSAR~1) -- o cenario reportado na issue #94.
    $env:LOCALAPPDATA = 'C:\Users\CSAR~1\AppData\Local'
    $metaCurto = Get-ReportMeta $null
    Assert-Equal $metaCurto['caminho_8_3'] 'sim' "Get-ReportMeta marca caminho_8_3=sim para forma curta"

    $env:LOCALAPPDATA = $origLocalAppData
    $metaNormal = Get-ReportMeta $null
    Assert-Equal $metaNormal['caminho_8_3'] 'nao' "Get-ReportMeta marca caminho_8_3=nao para forma longa"
    Assert-Equal ($null -eq $metaNormal['excecao']) $true "Get-ReportMeta sem ErrorRecord nao define 'excecao'"
} finally {
    $env:LOCALAPPDATA = $origLocalAppData
}

Write-Host "`n-- 2.4 Injecao oficial: estado por alvo, saida limitada e excecoes --" -ForegroundColor Yellow
$originalInvokePnpm = ${function:Invoke-Pnpm}
$originalGetInjectedPath = ${function:Get-InjectedPath}
$originalStopDiscord = ${function:Stop-Discord}
$injectionRoot = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassInjection_$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $injectionRoot -Force | Out-Null
$resourcesOne = Join-Path $injectionRoot 'Discord\app-1.0.0\resources'
$resourcesTwo = Join-Path $injectionRoot 'DiscordPTB\app-1.0.0\resources'
$script:mockInjectedPaths = @{}
$script:mockInjectionMode = 'success'
$script:mockInjectionArgs = @()
try {
    function Invoke-Pnpm([string[]]$Arguments) {
        $script:mockInjectionArgs = @($Arguments)
        switch ($script:mockInjectionMode) {
            'nonzero' { $script:PnpmExitCode = 9; Write-Output ('x' * 700); return }
            'exception' { $script:PnpmExitCode = 1; throw ('erro sintetico ' + ('x' * 700)) }
            default { $script:PnpmExitCode = 0; Write-Output 'injecao sintetica' }
        }
    }
    function Get-InjectedPath($resources) { return $script:mockInjectedPaths[$resources] }
    function Stop-Discord {}

    $targetOne = [pscustomobject]@{ Flavour = 'Discord'; Resources = $resourcesOne; Tipo = 'O' }
    $targetTwo = [pscustomobject]@{ Flavour = 'DiscordPTB'; Resources = $resourcesTwo; Tipo = 'O' }
    $script:mockInjectedPaths[$resourcesOne] = Join-Path $injectionRoot 'dist\desktop'
    Invoke-Injection $injectionRoot @($targetOne)
    Assert-Equal ($script:mockInjectionArgs -contains '--') $false "Invoke-Injection nao passa separador -- extra"
    Assert-Equal (($script:mockInjectionArgs -join '|') -eq 'run|inject|--location|' + (Split-Path -Parent (Split-Path -Parent $resourcesOne))) $true "Invoke-Injection passa --location da raiz do alvo"
    Assert-Equal ((Format-InjectionDetail ('x' * 700)).Length -le 603) $true "Detalhe de injecao longo e limitado"

    $script:mockInjectionMode = 'nonzero'
    try {
        Invoke-Injection $injectionRoot @($targetOne)
        Assert-Equal $true $true "Exit code nao zero com pos-condicao confirmada nao falha"
    } catch {
        Assert-Equal $false $true "Exit code nao zero com pos-condicao confirmada falhou: $($_.Exception.Message)"
    }

    $script:mockInjectedPaths.Remove($resourcesOne)
    $script:mockInjectionMode = 'success'
    try {
        Invoke-Injection $injectionRoot @($targetOne)
        Assert-Equal $false $true "Exit zero sem pos-condicao deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'pos-condicao nao confirmada') $true "Exit zero sem pos-condicao falha pelo estado do alvo"
    }

    $script:mockInjectedPaths[$resourcesOne] = Join-Path $injectionRoot 'dist\desktop'
    $script:mockInjectionMode = 'exception'
    try {
        Invoke-Injection $injectionRoot @($targetOne)
        Assert-Equal $true $true "Excecao com pos-condicao confirmada nao invalida o alvo"
    } catch {
        Assert-Equal $false $true "Excecao com pos-condicao confirmada falhou: $($_.Exception.Message)"
    }

    $script:mockInjectionMode = 'success'
    try {
        Invoke-Injection $injectionRoot @($targetOne, $targetTwo)
        Assert-Equal $false $true "Um alvo nao pode aprovar outro"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'DiscordPTB: pos-condicao nao confirmada') $true "Pos-condicao e verificada por alvo"
    }
} finally {
    Set-Item -Path Function:Invoke-Pnpm -Value $originalInvokePnpm
    Set-Item -Path Function:Get-InjectedPath -Value $originalGetInjectedPath
    Set-Item -Path Function:Stop-Discord -Value $originalStopDiscord
    if (Test-Path -LiteralPath $injectionRoot) { Remove-Item -LiteralPath $injectionRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 3. Wait-AntesDeFechar / Test-JanelaTransitoria" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
# Relato: no Windows 10 sem winget, o instalador falha e a janela "fecha sozinha" antes da
# pessoa ler o erro -- "Executar com o PowerShell" no Explorer spawna powershell.exe -File
# sem -NoExit. O .bat ja tem "pause" pra isso, mas quem roda so o .ps1 baixado direto (o
# link do README salva so o .ps1) nao passa por ele. Estes testes cobrem a parte
# deterministica (sem depender de bloquear em leitura de stdin, que nao e seguro forcar
# aqui): a deteccao devolve false neste ambiente (sem pai explorer.exe) e -Yes pula a
# checagem sem nem chamar Test-JanelaTransitoria. O caminho que de fato imprime o aviso e
# tenta ler Enter foi verificado manualmente (nao automatizado, para nao arriscar travar a
# suite se algum ambiente de CI conectar um stdin que nunca fecha).
foreach ($par in @(
    @{ nome = 'instalador'; wait = $installerWaitAntesDeFechar; janela = $installerTestJanela },
    @{ nome = 'standalone'; wait = $standaloneWaitAntesDeFechar; janela = $standaloneTestJanela }
)) {
    $Yes = $false
    Assert-Equal (& $par.janela) $false "Test-JanelaTransitoria ($($par.nome)) devolve false sem pai explorer.exe (ambiente de teste)"

    # Sem pai explorer.exe: Wait-AntesDeFechar precisa retornar sem tentar ler nada.
    & $par.wait
    Assert-Equal $true $true "Wait-AntesDeFechar ($($par.nome)) retorna sem bloquear quando nao e janela transitoria"

    # -Yes precisa pular a checagem de janela ANTES de chamar Test-JanelaTransitoria --
    # confirma substituindo a deteccao por uma que sempre explode; se Wait-AntesDeFechar
    # ainda assim chamar Test-JanelaTransitoria, o teste falha com excecao.
    $Yes = $true
    Set-Item "function:Test-JanelaTransitoria" { throw 'Test-JanelaTransitoria nao deveria ser chamada com -Yes' }
    try {
        & $par.wait
        Assert-Equal $true $true "Wait-AntesDeFechar ($($par.nome)) com -Yes nao chama Test-JanelaTransitoria"
    } catch {
        Assert-Equal $false $true "Wait-AntesDeFechar ($($par.nome)) com -Yes nao chama Test-JanelaTransitoria ($($_.Exception.Message))"
    }
    $Yes = $false
    # Restaura a deteccao real (nao remove): a proxima iteracao do loop tambem chama
    # Wait-AntesDeFechar, que resolve Test-JanelaTransitoria pelo nome em tempo de execucao.
    Set-Item "function:Test-JanelaTransitoria" $par.janela
}

# Confirma que os pontos de saida de sucesso e encerramento normal do standalone chamam Wait-AntesDeFechar
Assert-Equal ($standaloneContent.Trim().EndsWith("Wait-AntesDeFechar")) $true "Standalone tem Wait-AntesDeFechar no encerramento normal do script"
Assert-Equal ($standaloneContent -match 'Show-Status;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de Show-Status"
Assert-Equal ($standaloneContent -match 'Invoke-StandaloneCheckUpdate;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de CheckUpdate"
Assert-Equal ($standaloneContent -match 'Invoke-StandaloneUpdate;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de Update"

# Confirma que a saida apos instalar dependencias via winget no instalador chama Wait-AntesDeFechar
Assert-Equal ($installerContent -match 'Feche este terminal[\s\S]*?Wait-AntesDeFechar[\s\S]*?exit 0') $true "Instalador chama Wait-AntesDeFechar antes de sair apos instalar dependencias"

# Cleanup temp files
Remove-Item -LiteralPath $tempInstaller, $tempStandalone -Force -ErrorAction SilentlyContinue

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " Resumo dos Testes: $pass passaram, $fail falharam" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "========================================================`n" -ForegroundColor Cyan

if ($fail -gt 0) { exit 1 }
