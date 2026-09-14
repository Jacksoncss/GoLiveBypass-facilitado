import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const helperState = vi.hoisted(() => ({
    stdout: "",
    stderr: "",
    code: 0,
}));

vi.mock("child_process", () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
            kill: vi.fn(),
        });
        queueMicrotask(() => {
            if (helperState.stdout) child.stdout.emit("data", Buffer.from(helperState.stdout));
            if (helperState.stderr) child.stderr.emit("data", Buffer.from(helperState.stderr));
            child.emit("close", helperState.code);
        });
        return child;
    }),
}));

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

import { runConfgen } from "../../goLiveBypass/vpn-proton";

const temporaryRoots: string[] = [];

describe("logs do helper Proton", () => {
    it("registra fases, duração e bytes sem registrar stdin/stdout/stderr", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-helper-log-"));
        temporaryRoots.push(root);
        const executable = path.join(root, "proton-confgen");
        fs.writeFileSync(executable, "helper");
        fs.chmodSync(executable, 0o700);
        helperState.stdout = '{"success":true}\n';
        helperState.stderr = 'GOLIVE_PROGRESS {"phase":"testing","total":1,"tested":1,"succeeded":1}\nsecret-output\n';
        helperState.code = 0;
        const logs: Array<{ level: string; event: string; data?: Record<string, unknown> }> = [];

        const result = await runConfgen({
            exePath: executable,
            args: ["-stdin-secrets"],
            stdin: JSON.stringify({ password: "fake-password", token: "fake-token" }),
            log: (level, event, data) => logs.push({ level, event, data }),
        });

        expect(result.code).toBe(0);
        expect(logs.map(item => item.event)).toEqual(["helper.started", "helper.progress_sampled", "helper.completed"]);
        expect(logs.at(-1)?.data).toMatchObject({ stdout_bytes: expect.any(Number), stderr_bytes: expect.any(Number), exit_code: 0 });
        expect(JSON.stringify(logs)).not.toContain("fake-password");
        expect(JSON.stringify(logs)).not.toContain("fake-token");
        expect(JSON.stringify(logs)).not.toContain("secret-output");
    });
});
