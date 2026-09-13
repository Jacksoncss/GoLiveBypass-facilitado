#!/usr/bin/env node

// Paridade da redação L1 entre os dois clientes que falam com a mesma API. O módulo do
// plugin é autocontido (o zip não importa código da GUI), então o teste compara o
// comportamento das duas implementações puras em vez de prender o texto dos arquivos.

import assert from "node:assert/strict";
import { test } from "node:test";

import { l1Padroes as l1Plugin } from "../goLiveBypass/bug-report.ts";
import { l1Padroes as l1Gui } from "../golive-gui/electron/redact.ts";

// Casos que a GUI já cobre: as duas implementações precisam concordar.
const SONDAS = [
    "proxy=socks5://ana:Senha123@10.0.0.1:1080",
    "Authorization: Bearer abcdef",
    "proxy-authorization: Basic zzzzz",
    "token mfa.abcdefghijklmnopqrstuvwxyz012345 no log",
    "token MTAxMTIzNDU2Nzg5.MS4yMw.abcdefghijklmnopqrstuvwxyz0123456789 do usuario",
    "wss https://gateway-us-east1.discord.gg/?encoding=etf&v=9",
    "contato ana.silva@exemplo.com",
    "perfil /home/ana/.local/share/GoLiveBypass/golivebypass.log",
    "perfil C:\\Users\\ana\\AppData\\Local\\GoLiveBypass\\golivebypass.log",
    "usuario: ana",
];

test("L1 do plugin e da GUI concordam nos padrões compartilhados", () => {
    for (const sonda of SONDAS) assert.equal(l1Plugin(sonda), l1Gui(sonda), `divergência em: ${sonda}`);
});

test("o plugin acrescenta PrivateKey e Endpoint WireGuard", () => {
    const perfil = "PrivateKey = aG9sYQ==\nEndpoint = 203.0.113.7:51820";

    assert.equal(l1Gui(perfil), perfil, "a GUI não mexe no perfil; ela mascara isso em outro ponto");
    assert.equal(l1Plugin(perfil), "PrivateKey = <redacted>\nEndpoint = <redacted>");
});
