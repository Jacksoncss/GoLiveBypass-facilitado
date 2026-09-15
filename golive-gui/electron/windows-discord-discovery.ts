import path from "path";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return null;
  return [value];
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
  // A raw ExecutablePath/DisplayIcon may be an unquoted path containing spaces.
  // Treat it as one token only when every remainder is visibly a path segment;
  // command arguments (including an option ending in .exe) remain rejected.
  if (
    !commandInput.includes('"') &&
    /\.exe$/i.test(commandInput) &&
    command.args.every((arg) =>
      /[\\/]/.test(arg) &&
      !/^[A-Za-z]:[\\/]/.test(arg) &&
      !arg.startsWith("-") &&
      !arg.startsWith("/"),
    )
  ) {
    return commandInput;
  }
  return null;
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
