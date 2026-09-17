import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLinuxPrivilegedScript,
  formatLinuxWireGuardModuleIssue,
} from "../../goLiveBypass/vpn-linux";

describe("transporte Linux do plugin", () => {
  it("explica kernel sem módulos antes de pedir autorização", () => {
    expect(formatLinuxWireGuardModuleIssue("missing", "7.2.5-1-cachyos", false)).toContain("Reinicie");
    expect(formatLinuxWireGuardModuleIssue("missing", "7.2.5-1-cachyos", false)).toContain("7.2.5-1-cachyos");
    expect(formatLinuxWireGuardModuleIssue("missing", "7.2.5-1-cachyos", true)).toContain("módulo WireGuard");
    expect(formatLinuxWireGuardModuleIssue("loaded", "7.2.5-1-cachyos", false)).toBeNull();
    expect(formatLinuxWireGuardModuleIssue("available", "7.2.5-1-cachyos", true)).toBeNull();
  });

  it("agrupa comandos privilegiados e executa rollback no mesmo processo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-privileged-sequence-"));
    const marker = path.join(root, "rollback-marker");
    try {
      const script = buildLinuxPrivilegedScript(
        [
          ["/bin/sh", ["-c", "exit 7"]],
        ],
        [
          ["/usr/bin/touch", [marker]],
        ],
      );
      const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain("__GOLIVE_STEP__0");
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
