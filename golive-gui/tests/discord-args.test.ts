import { describe, expect, it } from "vitest";

import { argsExperimentaisDoDiscord, descreverQuicDoDiscord } from "../electron/discord-args";

describe("argsExperimentaisDoDiscord", () => {
  it("padrao: nenhum argumento, o Discord abre exatamente como antes", () => {
    expect(argsExperimentaisDoDiscord({})).toEqual([]);
    expect(argsExperimentaisDoDiscord({ experimentalDesativarQuic: false })).toEqual([]);
  });

  it("so o valor booleano true liga o --disable-quic", () => {
    expect(argsExperimentaisDoDiscord({ experimentalDesativarQuic: true })).toEqual(["--disable-quic"]);
  });

  it("valores parecidos com true nao ligam (evita ligar por engano ao editar o JSON)", () => {
    for (const valor of ["true", "sim", 1, "1", {}, [], null, undefined]) {
      expect(argsExperimentaisDoDiscord({ experimentalDesativarQuic: valor }), String(valor)).toEqual([]);
    }
  });

  it("nenhuma outra chave do settings consegue injetar argumento", () => {
    const hostil = {
      discordArgs: ["--remote-debugging-port=9222"],
      experimentalArgs: ["--no-sandbox"],
      experimentalDesativarQuic: ["--inspect"],
    };
    expect(argsExperimentaisDoDiscord(hostil)).toEqual([]);
  });

  it("a lista e fechada: so existe o --disable-quic", () => {
    const todos = argsExperimentaisDoDiscord({ experimentalDesativarQuic: true });
    expect(todos.every((arg) => arg === "--disable-quic")).toBe(true);
  });
});

describe("descreverQuicDoDiscord (campo do relatorio)", () => {
  it("diz qual condicao gerou o relatorio", () => {
    expect(descreverQuicDoDiscord({})).toBe("padrao");
    expect(descreverQuicDoDiscord({ experimentalDesativarQuic: true })).toBe("desativado_experimental");
    expect(descreverQuicDoDiscord({ experimentalDesativarQuic: "true" })).toBe("padrao");
  });
});
