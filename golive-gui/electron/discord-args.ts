// Argumentos experimentais para abrir o Discord, para testar uma causa de cada vez.
//
// Por que existe: o envio de arquivo que "carrega e some" (#368, #369, #370, #373) aparece em
// rotas do Mexico e some ao trocar de rota, e o tunel segue saudavel no log do WireSock. Uma das
// hipoteses abertas e o QUIC (HTTP/3 sobre UDP) do Chromium do Discord: o log de eventos do
// Electron de uma maquina de teste tem ERR_QUIC_PROTOCOL_ERROR na janela principal. Abrir o
// Discord com `--disable-quic` forca TCP/HTTP2 e separa essa hipotese das outras.
//
// A GUI reabre o Discord a cada ativacao e troca de rota, entao um teste manual se perderia na
// primeira reabertura; por isso o parametro vem do settings.json.
//
// Padrao desligado: sem a chave, o Discord abre exatamente como antes. A lista e fechada de
// proposito: nenhum valor do settings.json vira argumento de linha de comando, so este
// parametro conhecido e so quando a chave e o booleano `true` (nao "true", nem 1).

export const DISCORD_ARG_DESATIVAR_QUIC = "--disable-quic";

type SettingsLike = Record<string, unknown>;

export function argsExperimentaisDoDiscord(settings: SettingsLike): string[] {
  return settings.experimentalDesativarQuic === true ? [DISCORD_ARG_DESATIVAR_QUIC] : [];
}

/** Campo do relatorio: em qual condicao o Discord foi aberto. */
export function descreverQuicDoDiscord(settings: SettingsLike): "padrao" | "desativado_experimental" {
  return argsExperimentaisDoDiscord(settings).includes(DISCORD_ARG_DESATIVAR_QUIC)
    ? "desativado_experimental"
    : "padrao";
}
