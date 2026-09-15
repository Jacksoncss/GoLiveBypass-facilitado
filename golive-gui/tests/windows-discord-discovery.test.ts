import { describe, expect, it } from "vitest";
import path from "path";
import {
  createWindowsDiscoveryCache,
  flavourFromExecutableName,
  makeWindowsDiscoveryCandidate,
  mergeWindowsDiscoveryCandidates,
  normalizeWindowsDiscoveryPath,
  parseWindowsDiscoveryJson,
  toPublicWindowsDiscoveryInstall,
  validateWindowsExecutable,
  validateWindowsProcessExecutable,
  type WindowsDiscoveryCandidate,
  type WindowsDiscoveryEnvironment,
  type WindowsDiscoveryFileSystem,
  type WindowsDiscoverySnapshot,
} from "../electron/windows-discord-discovery";

function winKey(value: string): string {
  return path.win32.normalize(value).toLowerCase();
}

function fakeFs(files: string[], existing: string[] = []): WindowsDiscoveryFileSystem {
  const fileSet = new Set(files.map(winKey));
  const existingSet = new Set([...files, ...existing].map(winKey));
  return {
    exists: (target) => existingSet.has(winKey(target)),
    isFile: (target) => fileSet.has(winKey(target)),
  };
}

function candidate(
  source: WindowsDiscoveryCandidate["source"],
  flavour: "Discord" | "DiscordPTB",
  exePath: string,
  fs: WindowsDiscoveryFileSystem,
  processOnly = false,
): WindowsDiscoveryCandidate {
  const result = makeWindowsDiscoveryCandidate(source, flavour, exePath, fs, processOnly);
  if (!result) throw new Error(`fixture inválido: ${exePath}`);
  return result;
}

function emptySnapshot(capturedAtMs = 0): WindowsDiscoverySnapshot {
  return { installs: [], capturedAtMs };
}

describe("discovery Windows puro", () => {
  it("aceita schema=1 e normaliza row único do PowerShell 5.1", () => {
    const parsed = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: {
        status: "ok",
        rows: { name: "Discord.exe", pid: 42, path: "C:\\Discord\\Discord.exe" },
        truncated: false,
      },
      registry: {
        status: "empty",
        rows: [],
        truncated: false,
      },
    }));

    expect(parsed.schema).toBe(1);
    expect(parsed.process.rows).toEqual([
      { name: "Discord.exe", pid: 42, path: "C:\\Discord\\Discord.exe" },
    ]);
    expect(parsed.registry.rows).toEqual([]);
  });

  it("rejeita schema desconhecido e descarta rows com tipos inválidos", () => {
    expect(() => parseWindowsDiscoveryJson(JSON.stringify({
      schema: 2,
      process: { status: "ok", rows: [], truncated: false },
      registry: { status: "empty", rows: [], truncated: false },
    }))).toThrow("Schema");

    const parsed = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: {
        status: "partial",
        rows: [
          { name: "Discord.exe", pid: "42", path: "C:\\Discord\\Discord.exe" },
          { name: "Discord.exe", pid: 42, path: null },
        ],
        truncated: true,
        errorCode: "PROCESS_LIMIT",
      },
      registry: { status: "empty", rows: [], truncated: false },
    }));

    expect(parsed.process.rows).toEqual([{ name: "Discord.exe", pid: 42, path: null }]);
    expect(parsed.process).toMatchObject({ status: "partial", truncated: true, errorCode: "PROCESS_LIMIT" });
  });

  it("aplica ,0 somente ao token de displayIcon", () => {
    const executable = "C:\\Program Files\\Discord\\Discord.exe";
    expect(normalizeWindowsDiscoveryPath(`${executable},0`, "value")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(`"${executable}",0`, "value")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(`${executable},0`, "displayIcon")).toBe(executable);
    expect(normalizeWindowsDiscoveryPath(`"${executable}",0`, "displayIcon")).toBe(executable);
    expect(normalizeWindowsDiscoveryPath(`"${executable}"`, "value")).toBe(executable);
  });

  it("deriva flavour somente do nome exato do executável", () => {
    expect(flavourFromExecutableName("Discord.exe")).toBe("Discord");
    expect(flavourFromExecutableName("discordptb.EXE")).toBe("DiscordPTB");
    expect(flavourFromExecutableName("DiscordHelper.exe")).toBeNull();
    expect(flavourFromExecutableName("Update.exe")).toBeNull();
  });

  it("valida caminho customizado app-* sem exigir ancestral com nome flavour", () => {
    const exe = "D:\\MyDiscord\\app-1.0.10\\Discord.exe";
    const fs = fakeFs([exe]);
    expect(validateWindowsExecutable(exe, "Discord", fs)).toBe(exe);
    expect(validateWindowsProcessExecutable(exe, "Discord", fs)).toBe(exe);
  });

  it("aceita executável direto somente com resources ao lado", () => {
    const exe = "D:\\Custom\\Discord.exe";
    const resources = path.win32.join(path.win32.dirname(exe), "resources");
    const fs = fakeFs([exe], [resources]);
    expect(validateWindowsProcessExecutable(exe, "Discord", fs)).toBe(exe);
  });

  it("rejeita caminho relativo, UNC, ADS, argumentos, flavour falso e arquivo não regular", () => {
    const fs = fakeFs(["C:\\Discord\\Discord.exe"]);
    expect(normalizeWindowsDiscoveryPath("Discord.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("\\\\server\\share\\Discord.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("C:\\Discord\\payload:stream.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("C:\\Discord\\Discord.exe --flag", "process")).toBeNull();
    expect(validateWindowsExecutable("C:\\Discord\\Discord.exe", "DiscordPTB", fs)).toBeNull();
    expect(validateWindowsExecutable("C:\\Discord\\Discord.exe", "Discord", fakeFs([]))).toBeNull();
    expect(validateWindowsProcessExecutable("C:\\Custom\\Discord.exe", "Discord", fs)).toBeNull();
  });

  it("deduplica somente exePath, respeita precedência e preserva roots do mesmo flavour", () => {
    const stable = "C:\\One\\Discord.exe";
    const other = "D:\\Two\\Discord.exe";
    const fs = fakeFs([stable, other]);
    const merged = mergeWindowsDiscoveryCandidates([
      candidate("shortcut", "Discord", stable, fs),
      candidate("registry", "Discord", stable, fs),
      candidate("process", "Discord", stable, fs),
      candidate("root", "Discord", other, fs),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ exePath: stable, source: "process", detectedBy: "process" });
    expect(merged[1]).toMatchObject({ exePath: other, source: "root" });
    expect(toPublicWindowsDiscoveryInstall(merged[0])).toEqual({
      flavour: "Discord",
      resources: "C:\\One\\resources",
      exePath: stable,
    });
    expect(toPublicWindowsDiscoveryInstall(merged[0])).not.toHaveProperty("detectedBy");
  });

  it("mantém cache puro sem Electron, com TTL, stale e forceRefresh controlados por nowMs", () => {
    let nowMs = 0;
    let calls = 0;
    let env: WindowsDiscoveryEnvironment = { ProgramFiles: "C:\\Program Files" };
    const cache = createWindowsDiscoveryCache({
      nowMs: () => nowMs,
      readEnv: () => env,
      rootsForEnv: (current) => current.ProgramFiles ? [`${current.ProgramFiles}\\Discord`] : [],
      collectFresh: (_current, _roots) => { calls += 1; return emptySnapshot(); },
    });

    expect(cache.read()).toMatchObject({ stale: false });
    expect(calls).toBe(1);
    nowMs = 3_999;
    cache.read();
    expect(calls).toBe(1);
    nowMs = 4_000;
    cache.read();
    expect(calls).toBe(2);
    cache.read({ forceRefresh: true });
    expect(calls).toBe(3);

    env = { ProgramFiles: "D:\\Program Files" };
    cache.read();
    expect(calls).toBe(4);
  });

  it("usa stale por no máximo 8s somente quando permitido e falha sem stale", () => {
    let nowMs = 0;
    let calls = 0;
    const cache = createWindowsDiscoveryCache({
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => {
        calls += 1;
        if (calls > 1) throw new Error("fonte indisponível");
        return emptySnapshot();
      },
    });

    cache.read();
    nowMs = 4_001;
    const stale = cache.read({ allowStale: true });
    expect(stale.stale).toBe(true);
    expect(calls).toBe(2);
    expect(() => cache.read()).toThrow("fonte indisponível");
    nowMs = 8_000;
    expect(() => cache.read({ allowStale: true })).toThrow("fonte indisponível");
  });

  it("aceita ambiente sem LOCALAPPDATA quando roots dependentes ficam vazias", () => {
    let collectCalls = 0;
    let seenEnv: WindowsDiscoveryEnvironment | undefined;
    const cache = createWindowsDiscoveryCache({
      nowMs: () => 0,
      readEnv: () => ({ ProgramFiles: "C:\\Program Files" }),
      rootsForEnv: (env) => {
        seenEnv = env;
        return env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Discord`] : [];
      },
      collectFresh: () => { collectCalls += 1; return emptySnapshot(); },
    });

    cache.read({ forceRefresh: true });
    expect(collectCalls).toBe(1);
    expect(seenEnv).not.toHaveProperty("LOCALAPPDATA");
  });
});
