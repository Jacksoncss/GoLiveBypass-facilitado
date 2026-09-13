import { describe, expect, it } from "vitest";

import {
  formatProtonRoutePing,
  isProtonRouteSelectable,
  mergeProtonRouteCatalog,
  protonLoginPresentation,
  protonRouteStateLabel,
  recommendProtonRoute,
  reduceProtonRouteEvent,
  sortProtonRouteCandidates,
  type ProtonRouteCandidate,
} from "../../goLiveBypass/proton-manual-selection";


function candidate(server: string, overrides: Partial<ProtonRouteCandidate> = {}): ProtonRouteCandidate {
  return {
    server,
    pingStatus: "not-tested",
    preflightStatus: "not-tested",
    speedStatus: "not-tested",
    ...overrides,
  };
}


describe("modelo de rotas Proton do plugin", () => {
  it("preenche catálogo, ping, preflight e velocidade na mesma candidata", () => {
    let state = new Map<string, ProtonRouteCandidate>();
    state = reduceProtonRouteEvent(state, {
      phase: "catalog",
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
    });

    expect(state.get("NL#2")).toMatchObject({ pingStatus: "pending", preflightStatus: "not-tested", speedStatus: "not-tested" });
    expect(state.get("NL#2")).not.toHaveProperty("pingMs");

    state = reduceProtonRouteEvent(state, {
      phase: "catalog",
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
      pingMs: 188,
      status: "success",
    });
    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "NL#2", status: "success" });
    state = reduceProtonRouteEvent(state, {
      phase: "testing",
      server: "NL#2",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
      status: "success",
    });

    expect(state.get("NL#2")).toMatchObject({
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
      pingMs: 188,
      pingStatus: "success",
      preflightStatus: "success",
      speedStatus: "success",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
    });
    expect(isProtonRouteSelectable(state.get("NL#2")!)).toBe(true);
  });

  it("ignora ping fora da faixa válida e eventos de geração sem servidor", () => {
    let state = new Map<string, ProtonRouteCandidate>([[ "US#8", candidate("US#8", { pingMs: 188, pingStatus: "success" }) ]]);

    const withoutServer = reduceProtonRouteEvent(state, { phase: "ping", pingMs: 120, status: "success" });
    expect(withoutServer).toEqual(state);

    state = reduceProtonRouteEvent(withoutServer, { phase: "ping", server: "US#8", pingMs: 999, status: "success" });
    expect(state.get("US#8")).toMatchObject({ pingMs: 188, pingStatus: "success" });
    expect(state.get("US#8")).not.toHaveProperty("failureReason");
  });

  it("mantém estados independentes e não torna aplicável rota reprovada no preflight", () => {
    let state = new Map<string, ProtonRouteCandidate>();
    state = reduceProtonRouteEvent(state, { phase: "ping", server: "US#72", pingMs: 205, status: "success" });
    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "US#72", status: "failed" });

    expect(state.get("US#72")).toMatchObject({
      pingStatus: "success",
      preflightStatus: "failed",
      speedStatus: "not-tested",
      failureReason: "Falha no túnel ou HTTPS",
    });
    expect(isProtonRouteSelectable(state.get("US#72")!)).toBe(false);
    expect(protonRouteStateLabel(state.get("US#72")!, { discoveryActive: false })).toBe("Falha no túnel ou HTTPS");

    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "US#72", status: "success" });
    expect(state.get("US#72")).not.toHaveProperty("failureReason");
    expect(isProtonRouteSelectable(state.get("US#72")!)).toBe(true);
  });

  it("explica a linha sem medição pela fase da descoberta", () => {
    const catalogued = candidate("NL#2");
    expect(protonRouteStateLabel(catalogued, { discoveryActive: true })).toBe("Medindo ping");
    expect(protonRouteStateLabel(catalogued, { discoveryActive: false })).toBe("Indisponível");
    expect(protonRouteStateLabel(candidate("NL#2", { pingStatus: "failed" }), { discoveryActive: true })).toBe("Sem resposta ao ping");
    expect(formatProtonRoutePing(catalogued.pingMs)).toBe("—");
    expect(formatProtonRoutePing(188.4)).toBe("188 ms");
    expect(isProtonRouteSelectable(catalogued)).toBe(false);
  });

  it("preserva candidatas já medidas ao mesclar o catálogo final", () => {
    const measured = candidate("US#8", {
      pingMs: 205,
      pingStatus: "success",
      speedStatus: "success",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
    });

    const merged = mergeProtonRouteCatalog(new Map([["US#8", measured]]), [
      { server: "US#8", country: "US", city: "New York", tier: "Free", load: 40, score: 1 },
      { server: "DE#4", country: "DE", city: "Berlin", tier: "Free", load: 19, score: 3, pingMs: 197, status: "success" },
      { server: "   ", country: "XX" },
    ]);

    expect(merged.get("US#8")).toMatchObject({ pingMs: 205, pingStatus: "success", speedStatus: "success", downloadMbps: 42.5, uploadMbps: 8.2, city: "New York" });
    expect(merged.get("DE#4")).toMatchObject({ pingMs: 197, pingStatus: "success" });
    expect(merged.size).toBe(2);
  });

  it("ordena por ping crescente com nome normalizado como desempate estável", () => {
    const routes = [
      candidate("US#50", { pingMs: 198, pingStatus: "success" }),
      candidate("us#10", { pingMs: 150, pingStatus: "success" }),
      candidate("DE#1", { pingMs: 150, pingStatus: "success" }),
      candidate("US#99", { pingMs: 999, pingStatus: "success" }),
      candidate("US#72", { pingMs: 205, pingStatus: "failed" }),
    ];

    expect(sortProtonRouteCandidates(routes).map(route => route.server)).toEqual(["DE#1", "us#10", "US#50", "US#72", "US#99"]);
  });

  it("recomenda por capacidade harmônica e nunca uma rota sem ping válido ou reprovada", () => {
    const routes = [
      candidate("US#8", { pingMs: 188, pingStatus: "success", speedStatus: "success", downloadMbps: 80, uploadMbps: 10 }),
      candidate("US#50", { pingMs: 198, pingStatus: "success", speedStatus: "success", downloadMbps: 50, uploadMbps: 50 }),
      candidate("NL#2", { pingMs: 150, pingStatus: "success" }),
    ];

    expect(recommendProtonRoute(routes)).toBe("US#50");
    expect(recommendProtonRoute(routes.filter(route => route.server !== "US#50"))).toBe("US#8");
    expect(recommendProtonRoute([
      candidate("US#9", { pingMs: 120, pingStatus: "success", preflightStatus: "failed", speedStatus: "success", downloadMbps: 90, uploadMbps: 90 }),
      candidate("NL#2", { pingMs: 150, pingStatus: "success" }),
    ])).toBe("NL#2");
    expect(recommendProtonRoute([candidate("US#72", { pingStatus: "failed" })])).toBeUndefined();
  });
});

describe("apresentação compartilhada dos erros de login", () => {
  it("mantém causas distintas e só devolve o foco à senha quando a credencial foi rejeitada", () => {
    const invalidCredentials = protonLoginPresentation({ code: "INVALID_CREDENTIALS" });
    const helperFailure = protonLoginPresentation({ code: "HELPER_ERROR" });
    const captchaInvalid = protonLoginPresentation({ code: "CAPTCHA_INVALID" });
    const captchaCancelled = protonLoginPresentation({ code: "CAPTCHA_CANCELLED" });

    expect(invalidCredentials.focusPassword).toBe(true);
    expect(helperFailure.focusPassword).toBe(false);
    expect(helperFailure.message).not.toBe(invalidCredentials.message);
    expect(captchaInvalid.message).not.toBe(captchaCancelled.message);
  });

  it("não deixa detalhe textual reclassificar credencial e preserva diagnóstico desconhecido", () => {
    const rejection = protonLoginPresentation({ code: "INVALID_CREDENTIALS", error: "authentication failed: protocol error" });
    const canonicalRejection = protonLoginPresentation({ code: "INVALID_CREDENTIALS" });
    expect(rejection).toEqual(canonicalRejection);
    expect(protonLoginPresentation({ code: "UNKNOWN", error: "rejeição desconhecida\ndo Proton" }).message).toBe("rejeição desconhecida do Proton");
    expect(protonLoginPresentation({ code: "CONFIGURATION_ERROR", error: "configuração inválida" }).message).toBe("configuração inválida");
  });
});
