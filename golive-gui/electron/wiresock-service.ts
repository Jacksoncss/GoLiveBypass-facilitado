import { wireSockOwnershipPowerShell } from "./wiresock-ownership";

// Encode PowerShell instead of interpolating paths into cmd.exe. Only the
// exact GUI profile may authorize stopping or retargeting an existing service.
export function wireSockServiceScript(executable: string, config: string, resultPath?: string): string {
  for (const value of [executable, config, resultPath].filter((value): value is string => Boolean(value))) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command = `"${executable}" service -config "${config}" -log-level info -network-lock disabled`;
  const result = resultPath ? literal(resultPath) : "$null";
  // Windows PowerShell 5.1 reads -File as ANSI without a BOM. Preserve Unicode
  // paths (including the result file) when this string is written as UTF-8.
  return `\uFEFF$ErrorActionPreference = 'Stop'
$resultPath = ${result}
function Complete-WireSock([int]$code, [string]$detail) {
  if ($resultPath) {
    try { [IO.File]::WriteAllText($resultPath, "$code\n$detail", [Text.UTF8Encoding]::new($false)) } catch {}
  }
  exit $code
}
try {
  $serviceNames = @('wiresock-client-service', 'wiresock-pro-client-service')
  $expected = ${literal(command)}
  ${wireSockOwnershipPowerShell(config)}
  function Get-WireSockInfo {
    foreach ($candidate in $serviceNames) {
      $info = Get-CimInstance Win32_Service -Filter "Name='$candidate'" -ErrorAction Stop
      if ($info) { return $info }
    }
    return $null
  }
  function Wait-WireSockState([string]$serviceName, [string]$state, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
      $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($current -and $current.Status -eq $state) { return $true }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
  }
  function Stop-WireSockService([string]$serviceName) {
    Assert-GoLiveWireSockRegistration $serviceName
    $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $current -or $current.Status -eq 'Stopped') { return }
    $null = & sc.exe stop $serviceName
    if ($LASTEXITCODE -ne 0) {
      $stopCode = $LASTEXITCODE
      $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($current -and $current.Status -notin @('Stopped', 'StopPending')) {
        throw "STOP_FAILED: servico=$serviceName codigo=$stopCode"
      }
    }
    if (-not (Wait-WireSockState $serviceName 'Stopped' 45)) {
      $info = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
      throw "STOP_TIMEOUT: servico=$serviceName estado=$($info.State) Win32ExitCode=$($info.ExitCode) ServiceSpecificExitCode=$($info.ServiceSpecificExitCode)"
    }
  }

  $serviceInfo = Get-WireSockInfo
  $null = Get-GoLiveWireSockOwnership
  if ($serviceInfo) { Assert-GoLiveWireSockRegistration $serviceInfo.Name }
  if (-not $serviceInfo) {
    & ${literal(executable)} install -start-type 3 -config ${literal(config)} -log-level info -network-lock disabled
    $installCode = $LASTEXITCODE
    $serviceInfo = Get-WireSockInfo
    if ($installCode -ne 0 -and -not $serviceInfo) { throw "INSTALL_FAILED: codigo=$installCode" }
  }
  if (-not $serviceInfo) { throw 'SERVICE_MISSING: Serviço WireSock não encontrado após instalação' }
  $name = [string]$serviceInfo.Name
  Assert-GoLiveWireSockRegistration $name
  Stop-WireSockService $name

  Assert-GoLiveWireSockRegistration $name
  $change = Invoke-CimMethod -InputObject $serviceInfo -MethodName Change -Arguments @{PathName=$expected; StartMode='Manual'}
  if ($change.ReturnValue -ne 0) { throw "CONFIG_FAILED: codigo=$($change.ReturnValue)" }
  $actual = Get-WireSockInfo
  if (-not $actual -or $actual.PathName -cne $expected) { throw 'CONFIG_FAILED: O serviço WireSock permaneceu com outra configuração' }

  $lastStartError = ''
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Assert-GoLiveWireSockRegistration $name
      Start-Service -Name $name -ErrorAction Stop
      if (Wait-WireSockState $name 'Running' 45) {
        $running = Get-WireSockInfo
        Complete-WireSock 0 "SERVICE_RUNNING: name=$name pid=$($running.ProcessId) Win32ExitCode=$($running.ExitCode) ServiceSpecificExitCode=$($running.ServiceSpecificExitCode) path=$($running.PathName)"
      }
      $info = Get-WireSockInfo
      $lastStartError = "name=$name estado=$($info.State) pid=$($info.ProcessId) Win32ExitCode=$($info.ExitCode) ServiceSpecificExitCode=$($info.ServiceSpecificExitCode)"
    } catch {
      $startMessage = $_.Exception.Message
      $info = Get-WireSockInfo
      $lastStartError = "name=$name estado=$($info.State) pid=$($info.ProcessId) Win32ExitCode=$($info.ExitCode) ServiceSpecificExitCode=$($info.ServiceSpecificExitCode) erro=$startMessage"
    }
    if ($attempt -lt 2) { Start-Sleep -Seconds 2; Stop-WireSockService $name }
  }
  throw "START_FAILED: $lastStartError"
} catch {
  $detail = "GOLIVE_WIRESOCK_ERROR: $($_.Exception.Message)"
  [Console]::Error.WriteLine($detail)
  Complete-WireSock 1 $detail
}`;
}

/**
 * Starts WireSock in its official application mode. This is the primary path:
 * it routes only the configured applications for the logged-in user and avoids
 * inheriting a stale global Windows service profile.
 */
export function wireSockDirectScript(
  executable: string,
  config: string,
  resultPath: string,
  supervisor?: { guiPid: number; stopFlagPath: string },
): string {
  if (supervisor && !Number.isSafeInteger(supervisor.guiPid)) throw new Error("PID do app inválido");
  for (const value of [executable, config, resultPath, ...(supervisor ? [supervisor.stopFlagPath] : [])]) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `\uFEFF$ErrorActionPreference = 'Stop'
$resultPath = ${literal(resultPath)}
$stdoutPath = ${literal(resultPath + '.stdout')}
$stderrPath = ${literal(resultPath + '.stderr')}
${supervisor ? `$stopFlag = ${literal(supervisor.stopFlagPath)}\n$guiPid = ${supervisor.guiPid}\n` : ""}function Complete-WireSock([int]$code, [string]$detail, [bool]$leave = $true) {
  $payload = "$code\n$detail"
  try {
    [IO.File]::WriteAllText(($resultPath + '.tmp'), $payload, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force
  } catch {
    # O resultado é o único canal de diagnóstico do worker elevado: se a troca
    # do arquivo falhar, grava no destino final antes de sair.
    try { [IO.File]::WriteAllText($resultPath, $payload, [Text.UTF8Encoding]::new($false)) } catch {}
  }
  if ($leave) { exit $code }
}
function Read-Captured([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    $text = [IO.File]::ReadAllText($path)
    $text = [regex]::Replace($text, '\\s+', ' ').Trim()
    if ($text.Length -gt 1200) { return $text.Substring(0, 1200) + '…' }
    return $text
  } catch { return '' }
}
${wireSockOwnershipPowerShell(config)}
try {
  $null = Stop-GoLiveWireSock
  Start-Sleep -Milliseconds 500
  if ((Get-GoLiveWireSockOwnership).active) { throw 'WIRESOCK_INSPECTION_FAILED: outra instância iniciou durante a ativação' }
  Remove-Item -LiteralPath $resultPath, $stdoutPath, $stderrPath${supervisor ? ", $stopFlag, ($stopFlag + '.result')" : ""} -Force -ErrorAction SilentlyContinue
  $arguments = @('run', '-config', ('"' + ${literal(config)} + '"'), '-log-level', 'info', '-network-lock', 'disabled')
  $child = Start-Process -FilePath ${literal(executable)} -ArgumentList $arguments -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru -ErrorAction Stop
  # Cache the native handle before Refresh: Windows PowerShell otherwise loses
  # ExitCode for short-lived processes returned by Start-Process -PassThru.
  $processHandle = $child.Handle
  Start-Sleep -Seconds 3
  $child.Refresh()
  if ($child.HasExited) {
    $child.WaitForExit()
    $stdout = Read-Captured $stdoutPath
    $stderr = Read-Captured $stderrPath
    throw "DIRECT_EXITED: codigo=$($child.ExitCode) stdout=$stdout stderr=$stderr"
  }
  ${supervisor ? 'Complete-WireSock 0 "DIRECT_RUNNING: pid=$($child.Id) supervisor=$PID" $false' : 'Complete-WireSock 0 "DIRECT_RUNNING: pid=$($child.Id)"'}
} catch {
  $stdout = Read-Captured $stdoutPath
  $stderr = Read-Captured $stderrPath
  $detail = "GOLIVE_WIRESOCK_DIRECT_ERROR: $($_.Exception.Message)"
  if ($stdout -or $stderr) { $detail += " stdout=$stdout stderr=$stderr" }
  [Console]::Error.WriteLine($detail)
  Complete-WireSock 1 $detail
}${supervisor ? wireSockSupervisorPowerShell() : ""}`;
}

/**
 * Depois de subir o tunel, o worker elevado da ativacao nao sai: ele fica vivo (ja esta elevado, entao
 * nao precisa de outro UAC) e para o proprio tunel quando o app pede (arquivo de sinal) ou quando o
 * app fecha, mesmo que tenha caido. So para o que e da GUI, com a mesma checagem de dono da limpeza.
 * shortcut: o app so e dado como fechado apos 3 checagens seguidas sem o PID (1,5 s) e o PID nao e
 * comparado com o horario de inicio; se o Windows reaproveitar o PID, o supervisor so nao para sozinho.
 */
function wireSockSupervisorPowerShell(): string {
  return `
$guiMissing = 0
$tunnelGone = $false
try {
  while ($true) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $stopFlag) { break }
    $child.Refresh()
    if ($child.HasExited) { $tunnelGone = $true; break }
    if (Get-Process -Id $guiPid -ErrorAction SilentlyContinue) { $guiMissing = 0 } else { $guiMissing++ }
    if ($guiMissing -ge 3) { break }
  }
} catch {}
# O tunel que este supervisor cuidava ja saiu (por exemplo, uma nova ativacao o trocou): nao ha nada
# para parar, e parar "por perfil" agora poderia derrubar o tunel novo, que usa o mesmo perfil.
if ($tunnelGone) { exit 0 }
${wireSockStopAndReportPowerShell("($stopFlag + '.result')")}
Remove-Item -LiteralPath $stopFlag -Force -ErrorAction SilentlyContinue
exit 0`;
}

/** Cleans only an instance whose exact GUI config is revalidated under UAC. */
export function wireSockCleanupScript(config: string, resultPath: string): string {
  for (const value of [config, resultPath]) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `\uFEFF$ErrorActionPreference='Stop'
${wireSockOwnershipPowerShell(config)}
${wireSockStopAndReportPowerShell(literal(resultPath))}
if (-not $result.stopped) { exit 1 }
`;
}

/**
 * Para so o tunel cuja configuracao exata e a da GUI (Get-GoLiveWireSockOwnership falha fechada para
 * qualquer WireSock externo ou desconhecido) e grava o resultado em JSON no caminho dado. Usado pelo
 * script de limpeza elevado e pelo supervisor que fica vivo depois da ativacao. Exige que
 * wireSockOwnershipPowerShell ja tenha sido incluido antes.
 */
function wireSockStopAndReportPowerShell(resultLiteral: string): string {
  return `$result = [PSCustomObject]@{ stopped=$false; attempts=0; resetNetworkLock=$false; dnsCleared=$false; dnsFlushed=$false; servicesResidual=@(); processResidual=$false; residual=@() }
try {
  $initial = Get-GoLiveWireSockOwnership
  $result.attempts = 1
  $null = Stop-GoLiveWireSock
  if ($initial.active) {
    # GUI profiles omit DNS and use network-lock disabled. Config/PID ownership
    # does not authorize resetting a global lock or saved DNS of other adapters.
    if ((Get-GoLiveWireSockOwnership).active) { throw 'WIRESOCK_INSPECTION_FAILED: túnel reiniciou durante a limpeza' }
    try { $null = & ipconfig.exe /flushdns; $result.dnsFlushed = ($LASTEXITCODE -eq 0) } catch {}
  }
  $final = Get-GoLiveWireSockOwnership
  $result.stopped = -not $final.active
  if ($final.active) { throw 'STOP_TIMEOUT: WireSock próprio ainda está em execução' }
} catch {
  $result.residual = @($_.Exception.Message)
  $result.stopped = $false
}
[IO.File]::WriteAllText(${resultLiteral}, ($result | ConvertTo-Json -Compress -Depth 4), [Text.UTF8Encoding]::new($false))`;
}

/**
 * Recuperacao de rede do estado em que o instalador do WireSock falha e a
 * maquina fica sem saida. O fornecedor documenta
 * `wiresock-client.exe reset-network-lock` para o lock de driver ficar ligado
 * depois de uma saida anormal: enquanto ele estiver ligado, nada sai — e o
 * instalador quebrado e justamente o que troca esse driver. A rota default
 * orfa do adaptador virtual (que sem tunel manda tudo para o vazio) e o DNS
 * sao o resto do mesmo estado.
 *
 * O script nao para nem mexe em tunel nenhum: se houver `wiresock-client` em
 * execucao ele recusa, porque resetar o lock derrubaria a sessao de outro
 * controlador. Os candidatos vem do app, que ja conhece os diretorios
 * limitados do pacote oficial.
 */
export function wireSockNetworkRestoreScript(candidates: string[], resultPath: string): string {
  if (!resultPath || /["\r\n\0]/.test(resultPath)) throw new Error("Caminho WireSock inválido");
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const clients = candidates.map((value) => {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
    return literal(value);
  });
  return `\uFEFF$ErrorActionPreference = 'Continue'
$resultPath = ${literal(resultPath)}
$result = [PSCustomObject]@{ ok=$false; networkLockReset=$false; dnsFlushed=$false; adapterRoutesCleared=$false; residual=@() }
try {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='wiresock-client.exe'" -ErrorAction Stop)
  if ($running.Count -gt 0) {
    $result.residual += 'WIRESOCK_RUNNING: ha um WireSock em execucao; o lock de rede nao foi tocado para nao derrubar um tunel ativo'
  } else {
    $client = $null
    foreach ($candidate in @(${clients.join(",")})) {
      if (Test-Path -LiteralPath $candidate) { $client = $candidate; break }
    }
    if ($client) {
      $null = & $client reset-network-lock
      if ($LASTEXITCODE -eq 0) { $result.networkLockReset = $true }
      else { $result.residual += "NETWORK_LOCK_FAILED: codigo=$LASTEXITCODE" }
    } else {
      $result.residual += 'WIRESOCK_CLIENT_MISSING: nenhum wiresock-client.exe conhecido; o lock de driver nao pode ser resetado'
    }
    foreach ($adapter in @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ProTUN|WireSock|WireGuard' })) {
      $null = & netsh.exe interface ipv4 delete route 0.0.0.0/0 $adapter.Name
      $null = & netsh.exe interface ipv6 delete route ::/0 $adapter.Name
      $result.adapterRoutesCleared = $true
    }
    $null = & ipconfig.exe /flushdns
    $result.dnsFlushed = ($LASTEXITCODE -eq 0)
  }
  $result.ok = ($result.residual.Count -eq 0)
} catch {
  $result.residual += $_.Exception.Message
  $result.ok = $false
}
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Compress -Depth 4), [Text.UTF8Encoding]::new($false))
`;
}

/**
 * Runs a PowerShell file through UAC without copying the file contents into
 * an encoded command-line argument. Windows has a relatively small command
 * line limit; the WireSock service script is intentionally detailed enough
 * to exceed it when the script is nested in the elevation wrapper.
 */
export function elevatedPowerShellFileArgs(scriptPath: string, resultPath?: string): string[] {
  if (!scriptPath || /["\r\n\0]/.test(scriptPath) || (resultPath !== undefined && (!resultPath || /["\r\n\0]/.test(resultPath)))) throw new Error("Caminho do script PowerShell inválido");
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  // A worker redirecting a long-running child's output can stay alive with it.
  // For direct mode, wait for the explicit result, not for that worker to exit.
  if (resultPath) {
    const wrapper = `$ErrorActionPreference='Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$launch = @{FilePath='powershell.exe'; WindowStyle='Hidden'; PassThru=$true; ArgumentList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ('"' + ${literal(scriptPath)} + '"'))}
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $launch.Verb = 'RunAs' }
$worker = Start-Process @launch
$deadline = (Get-Date).AddSeconds(100)
do {
  if (Test-Path -LiteralPath ${literal(resultPath)}) {
    $result = [IO.File]::ReadAllText(${literal(resultPath)})
    if ($result -match '^(0|1)\\r?\\n.+') { exit [int]$Matches[1] }
  }
  $worker.Refresh()
  if ($worker.HasExited) { throw 'DIRECT_WORKER_EXITED: worker encerrou sem resultado' }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)
Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
throw 'DIRECT_WORKER_TIMEOUT: sem resultado de ativacao'`;
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
  }
  const wrapper = `$ErrorActionPreference='Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$scriptPath = ${literal(scriptPath)}
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath
  exit $LASTEXITCODE
}
$child = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ('"' + $scriptPath + '"'))
exit $child.ExitCode`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}
