// Config dedicada dos testes: SEM os plugins do Electron (vite.config.ts os aplica
// e eles reescrevem builtins como fs/path no ambiente de teste, travando a coleta).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // O código do plugin (fora da raiz deste pacote) importa `electron`: aponta para o stub
    // em vez do pacote real, que não carrega fora do Electron.
    alias: {
      electron: fileURLToPath(new URL("./tests/stubs/electron.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
