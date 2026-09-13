// Stub de `electron` para os testes que importam o código do plugin (que roda no processo
// principal do Discord). O pacote real não carrega fora do Electron: sem este alias, o
// vitest tentaria carregá-lo e a suíte nem seria coletada. Testes que precisam de um `app`
// de verdade continuam mockando "electron" por conta própria.
export const app = {
    exit: () => { },
    quit: () => { },
    relaunch: () => { },
    on: () => { },
    whenReady: async () => { },
};
export const ipcMain = { handle: () => { }, on: () => { } };
export const safeStorage = { isEncryptionAvailable: () => false };
