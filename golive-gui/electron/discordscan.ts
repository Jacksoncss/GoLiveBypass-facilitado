// Instrumentacao da deteccao do Discord — categoria "discord" no logger.
// Objetivo: quando a GUI NAO acha o Discord, o report de bug tem pistas do
// porque (raizes testadas, installs achados, stderr do script Linux, pgrep).

import * as logger from "./logger";

export function scanInicio(plataforma: string, localAppData?: string) {
  const data: Record<string, unknown> = { plataforma };
  if (plataforma === "win32") data.localappdata = localAppData || "ausente";
  logger.info("discord", "scan.inicio", data);
}

// Cada raiz/flavour testado: raiz + resultado do existsSync.
export function scanRaiz(raiz: string, existe: boolean, flavour?: string) {
  const data: Record<string, unknown> = { raiz, existe: existe ? "sim" : "nao" };
  if (flavour) data.flavour = flavour;
  logger.info("discord", "scan.raiz", data);
}

// Um install valido (app.asar ou _app.asar presentes).
export function scanInstall(resources: string, flavour: string) {
  logger.info("discord", "scan.install", { resources, flavour });
}

export function scanResultado(total: number) {
  logger.info("discord", "scan.resultado", { total });
}

export function runningPgrep(processo: string, ok: boolean, erro?: string) {
  const data: Record<string, unknown> = { processo, ok: ok ? "sim" : "nao" };
  if (erro) data.erro = erro;
  logger.info("discord", "running.pgrep", data);
}

export function runningTasklist(imagem: string, ok: boolean, erro?: string) {
  const data: Record<string, unknown> = { imagem, ok: ok ? "sim" : "nao" };
  if (erro) data.erro = erro;
  logger.info("discord", "running.tasklist", data);
}

// Resultado do script Linux --status --json: code + se o JSON parseou.
// O stderr (banner, avisos) nao vai mais como blob — as linhas de trace viram
// eventos proprios (scriptTrace) para o log ficar legivel.
export function scriptStatus(code: number, jsonOk: boolean) {
  logger.info("discord", "script.status", { code, json_ok: jsonOk ? "sim" : "nao" });
}

// Uma linha de aviso/trace do script (ex.: "trace: varridas 5 blocos, achei 1").
export function scriptTrace(linha: string) {
  logger.info("discord", "script.trace", { msg: linha.slice(0, 200) });
}

// Cada Discord que o script Linux encontrou (vem do JSON, com estado).
export function scriptInstall(
  path: string,
  state: string,
  extras?: { flavour?: string; detected_by?: string; flatpak_id?: string },
) {
  const data: Record<string, unknown> = { path, state };
  if (extras?.flavour) data.flavour = extras.flavour;
  if (extras?.detected_by) data.detected_by = extras.detected_by;
  if (extras?.flatpak_id) data.flatpak_id = extras.flatpak_id;
  logger.info("discord", "script.install", data);
}

export function scriptJsonInvalido(stdout: string) {
  logger.warn("discord", "script.json_invalido", { stdout_tail: stdout.slice(0, 200) });
}

// A ativacao falhou por nao achar o Discord: loga o resumo antes do throw.
export function ativacaoSemDiscord(motivo: string) {
  logger.warn("discord", "ativacao.sem_discord", { motivo });
}

// Descoberta Windows (#300): cada fonte reporta origem/status/contagem/truncation/
// errorCode e cada candidato reporta flavour/detected_by. Nenhum registro aceita
// caminho cru, CommandLine, argumentos, stdout ou PID: origem e detected_by sao
// categorias fechadas, entao um path nunca entra no log por este caminho.
export type DiscoveryScanSource = "root" | "process" | "registry" | "shortcut";
export type DiscoveryScanStatus = "ok" | "empty" | "partial" | "error";

export interface DiscoveryScanFonteExtras {
  total?: number;
  truncated?: boolean;
  errorCode?: string;
}

// Resultado de uma fonte pontual. "truncated" so aparece quando o teto de coleta
// foi atingido; errorCode so carrega o codigo estavel daquela fonte (nunca a
// excecao crua nem um caminho).
export function scanFonte(
  origem: DiscoveryScanSource,
  status: DiscoveryScanStatus,
  extras: DiscoveryScanFonteExtras = {},
) {
  const data: Record<string, unknown> = { origem, status };
  if (typeof extras.total === "number") data.total = extras.total;
  if (extras.truncated) data.truncated = "sim";
  if (extras.errorCode) data.error_code = extras.errorCode;
  logger.info("discord", "scan.fonte", data);
}

// Candidato aceito, sem path. detected_by e a origem de maior precedencia que
// venceu a deduplicacao para este flavour.
export function scanCandidato(flavour: string, detectedBy: DiscoveryScanSource) {
  logger.info("discord", "scan.candidato", { flavour, detected_by: detectedBy });
}
