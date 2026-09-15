import { execFileSync } from "child_process";
import path from "path";
import { findWindowsDiscordInstall, type WindowsDiscordInstall } from "./windows-discord-install";

export type WindowsDiscoveryFlavour =
  | "Discord"
  | "DiscordPTB"
  | "DiscordCanary"
  | "Vesktop"
  | "Equibop"
  | "Legcord";

export const WINDOWS_DISCOVERY_FLAVOURS: readonly WindowsDiscoveryFlavour[] = [
  "Discord",
  "DiscordPTB",
  "DiscordCanary",
  "Vesktop",
  "Equibop",
  "Legcord",
];

export type DiscoverySource = "root" | "process" | "registry" | "shortcut";
export type DiscoveryBlockStatus = "ok" | "empty" | "partial" | "error";
export type WindowsDiscoveryRegistryKind = "app-paths" | "uninstall" | "url-handler";
export type WindowsDiscoveryRegistryHive = "hkcu" | "hklm" | "wow6432";

export interface WindowsDiscoveryRawProcessRow {
  name: string;
  pid: number;
  path: string | null;
}

export interface WindowsDiscoveryRawRegistryRow {
  hive: WindowsDiscoveryRegistryHive;
  kind: WindowsDiscoveryRegistryKind;
  value: string;
  flavourHint?: string;
  displayIcon?: string;
  installLocation?: string;
}

export interface WindowsDiscoveryRawBlock<Row> {
  status: DiscoveryBlockStatus;
  rows: Row[];
  truncated: boolean;
  errorCode?: string;
}

export interface WindowsDiscoveryRaw {
  schema: 1;
  process: WindowsDiscoveryRawBlock<WindowsDiscoveryRawProcessRow>;
  registry: WindowsDiscoveryRawBlock<WindowsDiscoveryRawRegistryRow>;
}

export interface WindowsDiscoveryCandidate {
  source: DiscoverySource;
  flavour: WindowsDiscoveryFlavour;
  appDir: string;
  resources: string;
  exePath: string;
  detectedBy: DiscoverySource;
}

export interface WindowsDiscoverySnapshot {
  installs: WindowsDiscoveryCandidate[];
  capturedAtMs: number;
  stale?: boolean;
  collectionFailed: boolean;
  sourceFailure?: string;
}

export interface WindowsDiscoveryEnvironment {
  LOCALAPPDATA?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  PUBLIC?: string;
  ProgramData?: string;
  ProgramFiles?: string;
  "ProgramFiles(x86)"?: string;
  ProgramW6432?: string;
}

export interface WindowsDiscoveryFileSystem {
  exists: (target: string) => boolean;
  isFile: (target: string) => boolean;
  realpath?: (target: string) => string;
}

export interface WindowsDiscoveryCollectors {
  collectPowerShell: () => WindowsDiscoveryRaw;
  listDirectory: (root: string) => string[];
  exists: (file: string) => boolean;
  isFile: (file: string) => boolean;
  realpath?: (file: string) => string;
  readShortcut: (file: string) => { target: string; args: string };
}
export type WindowsDiscoveryPowerShellRunner = (file: string, args: readonly string[]) => string;

export interface WindowsDiscoveryRegistryHandlerDeps extends WindowsDiscoveryFileSystem {
  listDirectory: (root: string) => string[];
  findInstall: (
    root: string,
    flavour: string,
    exists: (target: string) => boolean,
    readdir: (target: string) => string[],
  ) => WindowsDiscordInstall | null;
}

export interface WindowsDiscoveryCacheDeps {
  platform: () => string;
  nowMs: () => number;
  readEnv: () => WindowsDiscoveryEnvironment;
  rootsForEnv: (env: WindowsDiscoveryEnvironment) => string[];
  collectFresh: (
    env: WindowsDiscoveryEnvironment,
    roots: string[],
  ) => WindowsDiscoverySnapshot;
}

export interface WindowsDiscoveryCache {
  read(options?: { forceRefresh?: boolean; allowStale?: boolean }): WindowsDiscoverySnapshot;
  invalidate(): void;
}

export const WINDOWS_DISCOVERY_TTL_MS = 4_000;
export const WINDOWS_DISCOVERY_STALE_MS = 8_000;

const FLAVOUR_BY_EXE = new Map<string, WindowsDiscoveryFlavour>(
  WINDOWS_DISCOVERY_FLAVOURS.map((flavour) => [`${flavour.toLowerCase()}.exe`, flavour]),
);

const RAW_STATUSES = new Set<DiscoveryBlockStatus>(["ok", "empty", "partial", "error"]);
const RAW_KINDS = new Set<WindowsDiscoveryRegistryKind>(["app-paths", "uninstall", "url-handler"]);
const RAW_HIVES = new Set<WindowsDiscoveryRegistryHive>(["hkcu", "hklm", "wow6432"]);
export const WINDOWS_DISCOVERY_POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$flavours = @('Discord','DiscordPTB','DiscordCanary','Vesktop','Equibop','Legcord')
$schemes = @('discord','discordptb','discordcanary','vesktop','equibop','legcord')
$processFilter = "Name = 'Discord.exe' OR Name = 'DiscordPTB.exe' OR Name = 'DiscordCanary.exe' OR Name = 'Vesktop.exe' OR Name = 'Equibop.exe' OR Name = 'Legcord.exe'"

# The 65th matching process is a sentinel: emit at most 64 rows but report truncation.
$processRows = @()
$processStatus = 'ok'
$processError = $null
$processTruncated = $false
try {
  $processMatches = @(Get-CimInstance Win32_Process -Filter $processFilter -ErrorAction Stop | ForEach-Object {
    $processPath = $null
    if ($_.ExecutablePath) { $processPath = [string]$_.ExecutablePath }
    [pscustomobject]@{
      name = [string]$_.Name
      pid = [int]$_.ProcessId
      path = $processPath
    }
  } | Select-Object -First 65)
  if ($processMatches.Count -gt 64) { $processTruncated = $true }
  $processRows = @($processMatches | Select-Object -First 64)
  if ($processRows.Count -eq 0 -and !$processTruncated) { $processStatus = 'empty' }
  elseif ($processTruncated) { $processStatus = 'partial' }
} catch {
  $processStatus = 'error'
  $processError = 'CIM_UNAVAILABLE'
}
$processBlock = [ordered]@{
  status = $processStatus
  rows = @($processRows)
  truncated = [bool]$processTruncated
}
if ($processError) { $processBlock['errorCode'] = $processError }

$registryRows = @()
$registryErrors = 0
$registryTruncated = $false
$appPathSpecs = @(
  @{hive='hkcu'; root='HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths'},
  @{hive='hklm'; root='HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths'},
  @{hive='wow6432'; root='HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'}
)
foreach ($spec in $appPathSpecs) {
  foreach ($flavour in $flavours) {
    try {
      $key = Join-Path $spec.root ($flavour + '.exe')
      if (Test-Path -LiteralPath $key) {
        $value = [string]((Get-Item -LiteralPath $key -ErrorAction Stop).GetValue(''))
        $registryRows += [pscustomobject]@{
          hive = $spec.hive
          kind = 'app-paths'
          value = $value
          flavourHint = $flavour
        }
      }
    } catch { $registryErrors++ }
  }
}

$urlSpecs = @(
  @{hive='hkcu'; root='HKCU:\Software\Classes'},
  @{hive='hklm'; root='HKLM:\Software\Classes'},
  @{hive='wow6432'; root='HKLM:\Software\WOW6432Node\Classes'}
)
for ($index = 0; $index -lt $schemes.Count; $index++) {
  foreach ($spec in $urlSpecs) {
    try {
      $key = Join-Path (Join-Path (Join-Path (Join-Path $spec.root $schemes[$index]) 'shell') 'open') 'command'
      if (Test-Path -LiteralPath $key) {
        $value = [string]((Get-Item -LiteralPath $key -ErrorAction Stop).GetValue(''))
        $registryRows += [pscustomobject]@{
          hive = $spec.hive
          kind = 'url-handler'
          value = $value
          flavourHint = $flavours[$index]
        }
      }
    } catch { $registryErrors++ }
  }
}

$uninstallSpecs = @(
  @{hive='hkcu'; root='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'},
  @{hive='hklm'; root='HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'},
  @{hive='wow6432'; root='HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'}
)
foreach ($spec in $uninstallSpecs) {
  try {
    # A 129th item is read only as a sentinel so the processed set stays bounded at 128.
    $subkeys = @(Get-ChildItem -LiteralPath $spec.root -ErrorAction Stop | Select-Object -First 129)
    if ($subkeys.Count -gt 128) { $registryTruncated = $true }
    foreach ($key in @($subkeys | Select-Object -First 128)) {
      try {
        $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
        $displayName = [string]$properties.DisplayName
        if (!$displayName -or $displayName -notmatch '(?i)(Discord|Vesktop|Equibop|Legcord)') { continue }
        $defaultValue = [string]((Get-Item -LiteralPath $key.PSPath -ErrorAction Stop).GetValue(''))
        $displayIcon = [string]$properties.DisplayIcon
        $installLocation = [string]$properties.InstallLocation
        $hint = $null
        if ($displayName -match '(?i)Discord\s*Canary') { $hint = 'DiscordCanary' }
        elseif ($displayName -match '(?i)Discord\s*PTB') { $hint = 'DiscordPTB' }
        elseif ($displayName -match '(?i)Discord') { $hint = 'Discord' }
        elseif ($displayName -match '(?i)Vesktop') { $hint = 'Vesktop' }
        elseif ($displayName -match '(?i)Equibop') { $hint = 'Equibop' }
        elseif ($displayName -match '(?i)Legcord') { $hint = 'Legcord' }
        $registryRows += [pscustomobject]@{
          hive = $spec.hive
          kind = 'uninstall'
          value = $defaultValue
          flavourHint = $hint
          displayIcon = $displayIcon
          installLocation = $installLocation
        }
      } catch { $registryErrors++ }
    }
  } catch { $registryErrors++ }
}

$registryStatus = 'ok'
if ($registryRows.Count -eq 0 -and $registryErrors -gt 0) { $registryStatus = 'error' }
elseif ($registryRows.Count -eq 0 -and !$registryTruncated) { $registryStatus = 'empty' }
elseif ($registryErrors -gt 0 -or $registryTruncated) { $registryStatus = 'partial' }
$registryBlock = [ordered]@{
  status = $registryStatus
  rows = @($registryRows)
  truncated = [bool]$registryTruncated
}
if ($registryErrors -gt 0 -and $registryRows.Count -eq 0) { $registryBlock['errorCode'] = 'REGISTRY_UNAVAILABLE' }
elseif ($registryErrors -gt 0) { $registryBlock['errorCode'] = 'REGISTRY_PARTIAL' }
elseif ($registryTruncated) { $registryBlock['errorCode'] = 'UNINSTALL_LIMIT' }

[pscustomobject]@{
  schema = 1
  process = [pscustomobject]$processBlock
  registry = [pscustomobject]$registryBlock
} | ConvertTo-Json -Compress -Depth 6
`;

export class WindowsDiscoveryCollectionError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string) {
    super(errorCode);
    this.name = "WindowsDiscoveryCollectionError";
    this.errorCode = errorCode;
  }
}

function defaultWindowsDiscoveryPowerShellRunner(file: string, args: readonly string[]): string {
  return String(execFileSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

export function buildWindowsDiscoveryPowerShell(): string {
  return WINDOWS_DISCOVERY_POWERSHELL_SCRIPT;
}

export function collectWindowsDiscoveryPowerShell(
  runner: WindowsDiscoveryPowerShellRunner = defaultWindowsDiscoveryPowerShellRunner,
): WindowsDiscoveryRaw {
  let stdout: string;
  try {
    stdout = runner("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_DISCOVERY_POWERSHELL_SCRIPT, "utf16le").toString("base64"),
    ]);
  } catch {
    throw new WindowsDiscoveryCollectionError("POWERSHELL_EXIT");
  }
  try {
    return parseWindowsDiscoveryJson(stdout);
  } catch {
    throw new WindowsDiscoveryCollectionError("JSON_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return null;
  return [value];
}
export interface WindowsDiscoveryCollectionHealth {
  collectionFailed: boolean;
  sourceFailure?: string;
}

export function summarizeWindowsDiscoveryCollection(
  raw: WindowsDiscoveryRaw,
): WindowsDiscoveryCollectionHealth {
  const failures: string[] = [];
  for (const [source, block] of [["process", raw.process], ["registry", raw.registry]] as const) {
    if (block.status === "error" || block.status === "partial" || block.truncated) {
      failures.push(`${source}:${block.errorCode || (block.truncated ? "truncated" : block.status)}`);
    }
  }
  return failures.length > 0
    ? { collectionFailed: true, sourceFailure: failures.join(",") }
    : { collectionFailed: false };
}

function parseBlock<Row>(
  value: unknown,
  parseRow: (row: unknown) => Row | null,
): WindowsDiscoveryRawBlock<Row> {
  if (!isRecord(value)) throw new Error("Bloco de discovery ausente ou inválido.");
  const status = value.status;
  const truncated = value.truncated;
  const rows = asRows(value.rows);
  if (typeof status !== "string" || !RAW_STATUSES.has(status as DiscoveryBlockStatus)) {
    throw new Error("Status de bloco de discovery inválido.");
  }
  if (typeof truncated !== "boolean" || rows === null) {
    throw new Error("Formato de bloco de discovery inválido.");
  }
  const parsedRows: Row[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed !== null) parsedRows.push(parsed);
  }
  const result: WindowsDiscoveryRawBlock<Row> = {
    status: status as DiscoveryBlockStatus,
    rows: parsedRows,
    truncated,
  };
  if (typeof value.errorCode === "string" && value.errorCode.trim()) {
    result.errorCode = value.errorCode.trim();
  }
  return result;
}

function parseProcessRow(value: unknown): WindowsDiscoveryRawProcessRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null;
  if (value.path !== null && typeof value.path !== "string") return null;
  return { name: value.name, pid: value.pid, path: value.path };
}

function parseRegistryRow(value: unknown): WindowsDiscoveryRawRegistryRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.hive !== "string" ||
    !RAW_HIVES.has(value.hive as WindowsDiscoveryRegistryHive) ||
    typeof value.kind !== "string" ||
    !RAW_KINDS.has(value.kind as WindowsDiscoveryRegistryKind) ||
    typeof value.value !== "string"
  ) return null;
  if (value.flavourHint !== undefined && typeof value.flavourHint !== "string") return null;
  if (value.displayIcon !== undefined && typeof value.displayIcon !== "string") return null;
  if (value.installLocation !== undefined && typeof value.installLocation !== "string") return null;
  const kind = value.kind as WindowsDiscoveryRegistryKind;
  if (kind !== "uninstall" && ("displayIcon" in value || "installLocation" in value)) return null;
  const result: WindowsDiscoveryRawRegistryRow = {
    hive: value.hive as WindowsDiscoveryRegistryHive,
    kind,
    value: value.value,
  };
  if (typeof value.flavourHint === "string") result.flavourHint = value.flavourHint;
  if (typeof value.displayIcon === "string") result.displayIcon = value.displayIcon;
  if (typeof value.installLocation === "string") result.installLocation = value.installLocation;
  return result;
}

export function parseWindowsDiscoveryJson(raw: string): WindowsDiscoveryRaw {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON de discovery inválido.");
  }
  if (!isRecord(value) || value.schema !== 1) {
    throw new Error("Schema de discovery desconhecido.");
  }
  return {
    schema: 1,
    process: parseBlock(value.process, parseProcessRow),
    registry: parseBlock(value.registry, parseRegistryRow),
  };
}

export interface WindowsDiscoveryCommand {
  executable: string;
  args: string[];
}

function tokenizeWindowsCommand(raw: string): string[] | null {
  if (/[\u0000-\u001f\u007f\r\n]/.test(raw)) return null;
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let tokenStarted = false;

  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === "\\") {
      let slashes = 0;
      while (raw[index + slashes] === "\\") slashes += 1;
      const next = raw[index + slashes];
      if (next === '"') {
        token += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          token += '"';
          tokenStarted = true;
          index += slashes + 1;
        } else {
          quoted = !quoted;
          tokenStarted = true;
          index += slashes + 1;
        }
      } else {
        token += "\\".repeat(slashes);
        tokenStarted = true;
        index += slashes;
      }
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      index += 1;
      continue;
    }
    token += char;
    tokenStarted = true;
    index += 1;
  }
  if (quoted) return null;
  if (tokenStarted) tokens.push(token);
  return tokens.length > 0 ? tokens : null;
}

export function parseWindowsDiscoveryCommand(raw: string): WindowsDiscoveryCommand | null {
  const tokens = tokenizeWindowsCommand(raw);
  if (!tokens || !tokens[0] || tokens.some((token) => /[\u0000-\u001f\u007f\r\n]/.test(token))) return null;
  return { executable: tokens[0], args: tokens.slice(1) };
}

function extractPathToken(raw: string, context: "process" | "value" | "displayIcon"): string | null {
  const input = raw.trim();
  if (!input) return null;
  const commandInput = context === "displayIcon" && /,0$/i.test(input)
    ? input.slice(0, -2).trimEnd()
    : input;
  const command = parseWindowsDiscoveryCommand(commandInput);
  if (!command) return null;
  if (command.args.length === 0) return command.executable;

  // ExecutablePath and DisplayIcon can be unquoted paths containing spaces.
  // Tokenization still validates quotes/control characters, while the first
  // .exe marker gives a deterministic boundary: anything after it is an arg.
  if (commandInput.includes('"') || !/^[A-Za-z]:[\\/]/.test(commandInput)) return null;
  const firstExe = commandInput.search(/\.exe/i);
  if (firstExe < 0) return null;
  const candidateEnd = firstExe + ".exe".length;
  if (commandInput.slice(candidateEnd).trim() !== "") return null;
  return commandInput.slice(0, candidateEnd).trim();
}

export function normalizeWindowsDiscoveryPath(
  raw: string,
  context: "process" | "value" | "displayIcon",
): string | null {
  const token = extractPathToken(raw, context);
  if (!token || /[\u0000-\u001f\u007f"\r\n,]/.test(token)) return null;
  if (!/^[A-Za-z]:[\\/]/.test(token)) return null;
  if (/^\\\\/.test(token) || /^\\\\[?.]/.test(token)) return null;
  if (token.slice(2).includes(":")) return null;
  if (token.split(/[\\/]+/).includes("..")) return null;

  const normalized = path.win32.normalize(token);
  if (!path.win32.isAbsolute(normalized) || !/\.exe$/i.test(normalized)) return null;
  return normalized;
}

export function flavourFromExecutableName(name: string): WindowsDiscoveryFlavour | null {
  const basename = path.win32.basename(name).toLowerCase();
  return FLAVOUR_BY_EXE.get(basename) ?? null;
}

function canonicalPathKey(value: string): string {
  return path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function fileIsValid(target: string, fsSeam: WindowsDiscoveryFileSystem): boolean {
  try {
    return fsSeam.exists(target) && fsSeam.isFile(target);
  } catch {
    return false;
  }
}

export function validateWindowsExecutable(
  target: string,
  flavour: WindowsDiscoveryFlavour,
  fsSeam: WindowsDiscoveryFileSystem,
): string | null {
  let normalized = normalizeWindowsDiscoveryPath(target, "process");
  if (!normalized || flavourFromExecutableName(normalized) !== flavour || !fileIsValid(normalized, fsSeam)) {
    return null;
  }
  if (fsSeam.realpath) {
    try {
      const resolved = normalizeWindowsDiscoveryPath(fsSeam.realpath(normalized), "process");
      if (!resolved || flavourFromExecutableName(resolved) !== flavour || !fileIsValid(resolved, fsSeam)) return null;
      normalized = resolved;
    } catch {
      return null;
    }
  }
  return normalized;
}

export function validateWindowsProcessExecutable(
  target: string,
  flavour: WindowsDiscoveryFlavour,
  fsSeam: WindowsDiscoveryFileSystem,
): string | null {
  const normalized = validateWindowsExecutable(target, flavour, fsSeam);
  if (!normalized) return null;
  const parent = path.win32.basename(path.win32.dirname(normalized));
  if (/^app-/i.test(parent)) return normalized;
  return fsSeam.exists(path.win32.join(path.win32.dirname(normalized), "resources")) ? normalized : null;
}

export function makeWindowsDiscoveryCandidate(
  source: DiscoverySource,
  flavour: WindowsDiscoveryFlavour,
  exePath: string,
  fsSeam: WindowsDiscoveryFileSystem,
  processOnly = false,
): WindowsDiscoveryCandidate | null {
  const validated = processOnly
    ? validateWindowsProcessExecutable(exePath, flavour, fsSeam)
    : validateWindowsExecutable(exePath, flavour, fsSeam);
  if (!validated) return null;
  const appDir = path.win32.dirname(validated);
  return {
    source,
    flavour,
    appDir,
    resources: path.win32.join(appDir, "resources"),
    exePath: validated,
    detectedBy: source,
  };
}
function hintedFlavour(value: string | undefined): WindowsDiscoveryFlavour | null {
  if (!value) return null;
  return WINDOWS_DISCOVERY_FLAVOURS.find((flavour) => flavour.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

function candidateFromRegistryExecutable(
  executable: string,
  flavour: WindowsDiscoveryFlavour | null,
  deps: WindowsDiscoveryRegistryHandlerDeps,
): WindowsDiscoveryCandidate | null {
  const executableFlavour = flavourFromExecutableName(executable);
  if (!executableFlavour || (flavour && executableFlavour !== flavour)) return null;
  return makeWindowsDiscoveryCandidate("registry", executableFlavour, executable, deps);
}

function candidateFromBoundedRoot(
  root: string,
  flavour: WindowsDiscoveryFlavour,
  deps: WindowsDiscoveryRegistryHandlerDeps,
): WindowsDiscoveryCandidate | null {
  const found = deps.findInstall(root, flavour, deps.exists, deps.listDirectory);
  return found ? makeWindowsDiscoveryCandidate("registry", flavour, found.exePath, deps) : null;
}

function candidateFromUpdateCommand(
  command: WindowsDiscoveryCommand,
  flavour: WindowsDiscoveryFlavour | null,
  deps: WindowsDiscoveryRegistryHandlerDeps,
): WindowsDiscoveryCandidate | null {
  const updater = normalizeWindowsDiscoveryPath(command.executable, "process");
  if (
    !updater ||
    path.win32.basename(updater).toLowerCase() !== "update.exe" ||
    !flavour ||
    command.args.length !== 2 ||
    command.args[0] !== "--processStart" ||
    flavourFromExecutableName(command.args[1]) !== flavour ||
    !fileIsValid(updater, deps)
  ) return null;
  return candidateFromBoundedRoot(path.win32.dirname(updater), flavour, deps);
}

function normalizeWindowsDiscoveryRoot(raw: string): string | null {
  const input = raw.trim();
  if (!input || /[\u0000-\u001f\u007f"\r\n,]/.test(input)) return null;
  const command = parseWindowsDiscoveryCommand(input);
  if (!command) return null;
  if (command.args.length > 0) {
    if (input.includes('"') || !/^[A-Za-z]:[\\/]/.test(input)) return null;
    if (command.args.some((arg) => !/[\\/]/.test(arg) || arg.startsWith("-") || arg.startsWith("/"))) return null;
  }
  if (!/^[A-Za-z]:[\\/]/.test(input) || /^\\\\/.test(input) || /^\\\\[?.]/.test(input)) return null;
  if (input.slice(2).includes(":") || input.split(/[\\/]+/).includes("..")) return null;
  return path.win32.normalize(command.args.length > 0 ? input : command.executable);
}

export function handleProcessRows(
  rows: readonly WindowsDiscoveryRawProcessRow[],
  fsSeam: WindowsDiscoveryFileSystem,
): WindowsDiscoveryCandidate[] {
  const candidates: WindowsDiscoveryCandidate[] = [];
  for (const row of rows) {
    const flavour = flavourFromExecutableName(row.name);
    if (!flavour || !row.path) continue;
    const candidate = makeWindowsDiscoveryCandidate("process", flavour, row.path, fsSeam, true);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function handleRegistryRows(
  rows: readonly WindowsDiscoveryRawRegistryRow[],
  deps: WindowsDiscoveryRegistryHandlerDeps,
): WindowsDiscoveryCandidate[] {
  const candidates: WindowsDiscoveryCandidate[] = [];
  for (const row of rows) {
    const flavour = hintedFlavour(row.flavourHint);
    if (row.kind === "app-paths" || row.kind === "url-handler") {
      const command = parseWindowsDiscoveryCommand(row.value);
      if (!command) continue;
      const candidate = row.kind === "url-handler"
        ? candidateFromUpdateCommand(command, flavour, deps) ??
          candidateFromRegistryExecutable(command.executable, flavour, deps)
        : command.args.length === 0
          ? candidateFromRegistryExecutable(command.executable, flavour, deps)
          : null;
      if (candidate) candidates.push(candidate);
      continue;
    }

    if (row.displayIcon) {
      const displayIcon = normalizeWindowsDiscoveryPath(row.displayIcon, "displayIcon");
      if (displayIcon) {
        const direct = candidateFromRegistryExecutable(displayIcon, flavour, deps);
        if (direct) candidates.push(direct);
        else if (path.win32.basename(displayIcon).toLowerCase() === "update.exe" && flavour) {
          const bounded = candidateFromBoundedRoot(path.win32.dirname(displayIcon), flavour, deps);
          if (bounded) candidates.push(bounded);
        }
      }
    }
    if (row.installLocation && flavour) {
      const root = normalizeWindowsDiscoveryRoot(row.installLocation);
      if (root) {
        const bounded = candidateFromBoundedRoot(root, flavour, deps);
        if (bounded) candidates.push(bounded);
      }
    }
  }
  return candidates;
}

const SOURCE_PRIORITY: Record<DiscoverySource, number> = {
  shortcut: 1,
  registry: 2,
  root: 3,
  process: 4,
};

export function mergeWindowsDiscoveryCandidates(
  candidates: readonly WindowsDiscoveryCandidate[],
): WindowsDiscoveryCandidate[] {
  const merged: WindowsDiscoveryCandidate[] = [];
  const indexes = new Map<string, number>();
  for (const candidate of candidates) {
    const key = canonicalPathKey(candidate.exePath);
    const previousIndex = indexes.get(key);
    if (previousIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(candidate);
      continue;
    }
    const previous = merged[previousIndex];
    if (SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[previous.source]) {
      merged[previousIndex] = candidate;
    }
  }
  return merged;
}

export type PublicWindowsDiscoveryInstall = Pick<WindowsDiscoveryCandidate, "flavour" | "resources" | "exePath">;

export function toPublicWindowsDiscoveryInstall(
  candidate: WindowsDiscoveryCandidate,
): PublicWindowsDiscoveryInstall {
  return {
    flavour: candidate.flavour,
    resources: candidate.resources,
    exePath: candidate.exePath,
  };
}

function cacheKey(platform: string, env: WindowsDiscoveryEnvironment, roots: readonly string[]): string {
  const knownEnv: Record<string, string> = {};
  for (const key of [
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "PUBLIC",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
  ] as const) {
    knownEnv[key] = env[key] ?? "";
  }
  return JSON.stringify({ platform, env: knownEnv, roots: [...roots].sort().map(canonicalPathKey) });
}

function copySnapshot(snapshot: WindowsDiscoverySnapshot, stale: boolean): WindowsDiscoverySnapshot {
  return {
    installs: [...snapshot.installs],
    capturedAtMs: snapshot.capturedAtMs,
    stale,
    collectionFailed: snapshot.collectionFailed,
    sourceFailure: snapshot.sourceFailure,
  };
}

export function createWindowsDiscoveryCache(deps: WindowsDiscoveryCacheDeps): WindowsDiscoveryCache {
  let cached: { key: string; snapshot: WindowsDiscoverySnapshot } | null = null;

  const read = (options: { forceRefresh?: boolean; allowStale?: boolean } = {}): WindowsDiscoverySnapshot => {
    const now = deps.nowMs();
    const env = deps.readEnv();
    const roots = deps.rootsForEnv(env);
    const key = cacheKey(deps.platform(), env, roots);
    const forceRefresh = options.forceRefresh === true;
    const allowStale = options.allowStale === true && !forceRefresh;

    const previous = !forceRefresh && cached?.key === key ? cached : null;
    const age = previous ? now - previous.snapshot.capturedAtMs : Number.POSITIVE_INFINITY;
    if (previous && age >= 0 && age < WINDOWS_DISCOVERY_TTL_MS) {
      return copySnapshot(previous.snapshot, false);
    }

    try {
      const fresh = deps.collectFresh(env, roots);
      const degraded = fresh.collectionFailed || Boolean(fresh.sourceFailure);
      if (previous && allowStale && age >= 0 && age < WINDOWS_DISCOVERY_STALE_MS && degraded) {
        return copySnapshot(previous.snapshot, true);
      }
      cached = {
        key,
        snapshot: { ...fresh, capturedAtMs: now, stale: false },
      };
      return copySnapshot(cached.snapshot, false);
    } catch (error) {
      if (previous && allowStale && age >= 0 && age < WINDOWS_DISCOVERY_STALE_MS) {
        return copySnapshot(previous.snapshot, true);
      }
      throw error;
    }
  };

  return {
    read,
    invalidate: () => { cached = null; },
  };
}
