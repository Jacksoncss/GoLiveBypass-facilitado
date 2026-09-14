$ErrorActionPreference = 'Stop'
$drive = 'E:'
if (-not (Test-Path -LiteralPath (Join-Path $drive 'test.ps1'))) { throw 'FAT share nao encontrado em E:' }
$out = Join-Path $drive 'result.txt'
$work = Join-Path $env:TEMP 'golive-vencord-preserve-test'
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work -Force | Out-Null
$installer = Get-Content -LiteralPath (Join-Path $drive 'inst.ps1') -Raw
$installerPath = Join-Path $drive 'inst.ps1'
$installerBytes = [IO.File]::ReadAllBytes($installerPath)
if ($installerBytes.Length -lt 3 -or $installerBytes[0] -ne 0xEF -or $installerBytes[1] -ne 0xBB -or $installerBytes[2] -ne 0xBF) { throw 'installer PS1 sem UTF-8 BOM' }
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -ne 0) { throw ('installer PS1 com erros de AST: ' + (($parseErrors | ForEach-Object Message) -join '; ')) }
$marker = $installer.LastIndexOf('Show-Banner')
if ($marker -lt 0) { throw 'chamada final Show-Banner nao encontrada' }
$functionsPath = Join-Path $work 'functions.ps1'
Set-Content -LiteralPath $functionsPath -Value $installer.Substring(0, $marker) -Encoding UTF8
. $functionsPath
$env:LOCALAPPDATA = Join-Path $work 'LocalAppData'
$env:USERPROFILE = Join-Path $work 'UserProfile'
$env:XDG_CONFIG_HOME = Join-Path $work 'Config'
$local = $env:LOCALAPPDATA
$discordResources = Join-Path $local 'Discord\app-1.0.0\resources'
$patcherData = Join-Path $work 'VencordData\dist'
New-Item -ItemType Directory -Path $discordResources,$patcherData -Force | Out-Null
Set-Content -LiteralPath (Join-Path $discordResources 'app.asar') -Value ('require("' + $patcherData + '\patcher.js")') -NoNewline
Set-Content -LiteralPath (Join-Path $discordResources '_app.asar') -Value 'stock-discord' -NoNewline
$originalApp = (Get-FileHash (Join-Path $discordResources 'app.asar')).Hash
$originalBackup = (Get-FileHash (Join-Path $discordResources '_app.asar')).Hash
$script:DiscordResourcesForTest = @($discordResources)
function global:Get-DiscordResources { return $script:DiscordResourcesForTest }
$Yes = $true
$PluginDirName = 'goLiveBypass'
$REPORT_NO_AUTO = 1
# O gate atual vive em Find-Checkout: quando a injeção revela um mod, mas nenhum checkout
# é provado, ele devolve $null. Select-Target segue para o menu de download e não é o alvo
# deste cenário.
$checkout = Find-Checkout
if ($checkout) { throw 'Find-Checkout aceitou Vencord sem checkout' }
if ((Get-FileHash (Join-Path $discordResources 'app.asar')).Hash -ne $originalApp) { throw 'app.asar mudou na recusa' }
if ((Get-FileHash (Join-Path $discordResources '_app.asar')).Hash -ne $originalBackup) { throw '_app.asar mudou na recusa' }
$parallel = Join-Path $local 'Vesktop\resources'
$equicord = Join-Path $work 'Equicord'
New-Item -ItemType Directory -Path $parallel,$equicord,(Join-Path $equicord 'src\utils'),(Join-Path $equicord 'dist') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $equicord 'package.json') -Value '{"name":"equicord"}'
Set-Content -LiteralPath (Join-Path $equicord 'src\utils\types.ts') -Value 'types'
Set-Content -LiteralPath (Join-Path $equicord 'dist\equibop.asar') -Value 'equicord-build'
Set-Content -LiteralPath (Join-Path $parallel 'app.asar') -Value ('require("' + $patcherData + '\patcher.js")') -NoNewline
Set-Content -LiteralPath (Join-Path $parallel '_app.asar') -Value 'parallel-original' -NoNewline
$parallelApp = (Get-FileHash (Join-Path $parallel 'app.asar')).Hash
$parallelBackup = (Get-FileHash (Join-Path $parallel '_app.asar')).Hash
$result = Copy-PatchParallel $equicord $parallel
if ($result.Ok) { throw 'paralelo patchado foi sobrescrito' }
if ((Get-FileHash (Join-Path $parallel 'app.asar')).Hash -ne $parallelApp) { throw 'app.asar paralelo mudou' }
if ((Get-FileHash (Join-Path $parallel '_app.asar')).Hash -ne $parallelBackup) { throw '_app.asar paralelo mudou' }
$checkout = Join-Path $work 'Vencord'
$plugin = Join-Path $checkout 'src\userplugins\goLiveBypass'
New-Item -ItemType Directory -Path $plugin,(Join-Path $checkout 'src\utils'),(Join-Path $checkout 'dist\desktop') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $checkout 'package.json') -Value '{"name":"vencord"}'
Set-Content -LiteralPath (Join-Path $checkout 'src\utils\types.ts') -Value 'types'
Set-Content -LiteralPath (Join-Path $plugin 'index.tsx') -Value 'plugin'
Set-Content -LiteralPath (Join-Path $checkout 'dist\desktop\index.js') -Value 'require("./goLiveBypass.js")'
Set-Content -LiteralPath (Join-Path $checkout 'dist\desktop\goLiveBypass.js') -Value 'console.log("vencord-plugin-loaded")'
$loaded = (& node (Join-Path $checkout 'dist\desktop\index.js') 2>&1)
if ($loaded -ne 'vencord-plugin-loaded') { throw 'loader Vencord nao carregou o plugin' }
$script:BuildLog = Join-Path $checkout 'build.log'
Set-Content -LiteralPath $script:BuildLog -Value 'build-before'
function global:pnpm { param([Parameter(ValueFromRemainingArguments = $true)]$Args) Add-Content -LiteralPath $script:BuildLog -Value ($Args -join ' ') }
function global:Invoke-Pnpm([string[]]$Arguments) {
    & pnpm @Arguments
    $script:PnpmExitCode = 0
}
Remove-PluginSource $checkout
if (Test-Path -LiteralPath $plugin) { throw 'plugin nao foi removido' }
if (-not ((Get-FileHash (Join-Path $discordResources 'app.asar')).Hash -eq $originalApp)) { throw 'remoção mudou app.asar' }
if (-not ((Get-FileHash (Join-Path $discordResources '_app.asar')).Hash -eq $originalBackup)) { throw 'remoção mudou _app.asar' }
if (-not ((Get-Content -LiteralPath $script:BuildLog) -contains 'build')) { throw 'remoção nao recompilou' }
$script:RestoreRoot = $checkout
function global:Find-Checkout { return $script:RestoreRoot }
function global:Stop-Discord { }
function global:Remove-Tor { }
Invoke-RestoreEverything | Out-Null
if ((Get-Content -LiteralPath $script:BuildLog) -match 'uninject') { throw 'Restore chamou pnpm uninject' }
Add-Content -LiteralPath $out -Value 'RESULT: PASS'
Add-Content -LiteralPath $out -Value 'CHECK: Vencord sem checkout recusado; app.asar/_app.asar intactos'
Add-Content -LiteralPath $out -Value 'CHECK: paralelo patchado preservado'
Add-Content -LiteralPath $out -Value 'CHECK: loader Vencord carregou plugin'
Add-Content -LiteralPath $out -Value 'CHECK: temporario/Restore removeram somente GoLiveBypass e nao chamaram uninject'
Write-Output $out
