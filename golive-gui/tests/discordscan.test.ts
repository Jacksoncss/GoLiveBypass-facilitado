import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import * as logger from "../electron/logger";
import {
  _resetDiscoveryLogDedupe,
  runningTasklist,
  sanitizeDiscoveryPath,
  scanCandidato,
  scanInicio,
  scanInstall,
  scanRaiz,
  scanResultado,
} from "../electron/discordscan";

let dir: string;

const MANAGED_ENV = [
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "ProgramData",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const USER = "zoe";
const LOCAL_APPDATA = `C:\\Users\\${USER}\\AppData\\Local`;
const PROGRAM_FILES_X86 = "C:\\Program Files (x86)";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-discordscan-"));
  logger._resetForTests();
  logger.initLogger(dir);
  _resetDiscoveryLogDedupe();
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  process.env.LOCALAPPDATA = LOCAL_APPDATA;
  process.env.APPDATA = `C:\\Users\\${USER}\\AppData\\Roaming`;
  process.env.USERPROFILE = `C:\\Users\\${USER}`;
  process.env.ProgramFiles = "C:\\Program Files";
  process.env["ProgramFiles(x86)"] = PROGRAM_FILES_X86;
  process.env.ProgramW6432 = "C:\\Program Files";
  process.env.PUBLIC = "C:\\Users\\Public";
  process.env.ProgramData = "C:\\ProgramData";
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ok
  }
});

describe("discordscan — contratos de segurança do diagnóstico", () => {
  it("troca raízes conhecidas por placeholder sem expor o usuário", () => {
    const local = `${LOCAL_APPDATA}\\Discord`;
    const x86 = `${PROGRAM_FILES_X86}\\Discord`;

    expect(sanitizeDiscoveryPath(local)).toBe("%LOCALAPPDATA%\\Discord");
    expect(sanitizeDiscoveryPath(x86)).toBe("%PROGRAMFILES(X86)%\\Discord");
    expect(sanitizeDiscoveryPath(local)).not.toContain(USER);
  });

  it("caminho customizado vira hash, sem texto cru de pasta ou usuário", () => {
    const customUnderLocal = `${LOCAL_APPDATA}\\Segredo\\Discord`;
    const arbitrary = "D:\\Jogos\\Segredo\\Discord";

    const sobPlaceholder = sanitizeDiscoveryPath(customUnderLocal);
    const arbitrario = sanitizeDiscoveryPath(arbitrary);

    expect(sobPlaceholder.startsWith("%LOCALAPPDATA%")).toBe(true);
    expect(sobPlaceholder).not.toContain("Segredo");
    expect(sobPlaceholder).not.toContain(USER);

    expect(arbitrario.startsWith("<path:")).toBe(true);
    expect(arbitrario).not.toContain("Segredo");
    expect(arbitrario).not.toContain("D:\\Jogos");
  });

  it("limita o tamanho de um tail conhecido (clipping)", () => {
    const tailLongo = "\\Discord" + "\\app-1".repeat(40);
    const sanitized = sanitizeDiscoveryPath(`${LOCAL_APPDATA}${tailLongo}`);

    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized.length).toBeLessThan(tailLongo.length);
    expect(sanitized.startsWith("%LOCALAPPDATA%\\Discord")).toBe(true);
  });

  it("scanInicio/scanRaiz/scanInstall registram sem usuário nem caminho cru", () => {
    scanInicio("win32", LOCAL_APPDATA);
    scanRaiz(`${LOCAL_APPDATA}\\Discord`, true, "Discord");
    scanInstall(`${LOCAL_APPDATA}\\Discord\\app-1.0.10\\resources`, "Discord");
    scanResultado(1);

    const recent = logger.getRecent();
    expect(recent).toContain("localappdata=%LOCALAPPDATA%");
    expect(recent).toContain("%LOCALAPPDATA%\\Discord");
    expect(recent).toContain("flavour=Discord");
    expect(recent).toContain("existe=sim");
    expect(recent).toContain("total=1");
    expect(recent).not.toContain(USER);
    expect(recent).not.toContain(LOCAL_APPDATA);
  });

  it("scanRaiz de instalação externa preserva existe/flavour sem vazar o custom", () => {
    scanRaiz("D:\\Jogos\\Segredo\\Discord", false, "Discord");

    const recent = logger.getRecent();
    expect(recent).toContain("<path:");
    expect(recent).toContain("existe=nao");
    expect(recent).toContain("flavour=Discord");
    expect(recent).not.toContain("Segredo");
    expect(recent).not.toContain("D:\\Jogos");
  });
  it("não reemite raiz idêntica durante uma leitura em cache", () => {
    const raiz = "C:\\CacheHit\\Discord";

    scanRaiz(raiz, true, "Discord");
    logger.info("discord", "teste.marcador", {});
    scanRaiz(raiz, true, "Discord");

    const recent = logger.getRecent();
    expect((recent.match(/scan\.raiz/g) ?? []).length).toBe(1);
  });
});

const contar = (texto: string, trecho: string) => texto.split(trecho).length - 1;

function varreduraCompleta(total: number) {
  scanInicio("win32", LOCAL_APPDATA);
  scanRaiz(`${LOCAL_APPDATA}\\Discord`, true, "Discord");
  scanCandidato("Discord", "root");
  scanInstall(`${LOCAL_APPDATA}\\Discord\\app-1.0.10\\resources`, "Discord");
  scanResultado(total);
}

describe("discordscan — varredura repetida não inunda o relatório", () => {
  it("uma varredura inalterada é registrada uma vez só", () => {
    varreduraCompleta(1);
    logger.info("discord", "teste.marcador", {});
    varreduraCompleta(1);

    const recent = logger.getRecent();
    for (const tipo of ["scan.inicio", "scan.raiz", "scan.candidato", "scan.install", "scan.resultado"]) {
      expect(contar(recent, tipo), tipo).toBe(1);
    }
  });

  it("volta a registrar quando o resultado muda", () => {
    varreduraCompleta(1);
    logger.info("discord", "teste.marcador", {});
    scanResultado(0);

    const recent = logger.getRecent();
    expect(recent).toContain("total=1");
    expect(recent).toContain("total=0");
  });

  it("registra de novo depois da janela, para o relatório ter sempre uma varredura recente", () => {
    const agora = Date.now();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(agora);
      varreduraCompleta(1);
      logger.info("discord", "teste.marcador", {});
      spy.mockReturnValue(agora + 11 * 60_000);
      varreduraCompleta(1);
    } finally {
      spy.mockRestore();
    }

    expect(contar(logger.getRecent(), "scan.resultado")).toBe(2);
  });

  it("running.tasklist só repete quando o estado muda", () => {
    runningTasklist("Discord", true);
    logger.info("discord", "teste.marcador", {});
    runningTasklist("Discord", true);
    logger.info("discord", "teste.marcador", {});
    runningTasklist("Discord", false);

    const recent = logger.getRecent();
    expect(recent).toContain("ok=sim");
    expect(contar(recent, "running.tasklist")).toBe(2);
  });
});
