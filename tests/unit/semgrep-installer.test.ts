import { describe, expect, it, beforeEach, mock } from "bun:test";

// Mock vscode module before importing the installer
mock.module("vscode", () => ({
    ExtensionContext: class { },
}));

import { SemgrepInstaller } from "../../packages/extension/src/utils/semgrep-installer";

describe("SemgrepInstaller", () => {
    let installer: SemgrepInstaller;
    let mockExec: any;
    let mockFs: any;
    let mockContext: any;

    beforeEach(() => {
        mockContext = {};
        mockFs = {
            existsSync: mock((path: string) => false),
        };
        mockExec = mock((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            callback(null, "success", "");
        });

        installer = new SemgrepInstaller(mockContext, mockExec, mockFs);
    });

    it("should return true if semgrep is in venv", async () => {
        mockFs.existsSync.mockImplementation((path: string) => path.includes("semgrep"));

        const result = await installer.isAvailable();
        expect(result).toBe(true);
    });

    it("should return true if semgrep is in global path", async () => {
        mockFs.existsSync.mockImplementation(() => false);
        mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            if (cmd === "semgrep --version") {
                callback(null, "1.0.0", "");
            } else {
                callback(new Error("not found"), "", "");
            }
        });

        const result = await installer.isAvailable();
        expect(result).toBe(true);
    });

    it("should return false if semgrep is missing", async () => {
        mockFs.existsSync.mockImplementation(() => false);
        mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            callback(new Error("not found"), "", "");
        });

        const result = await installer.isAvailable();
        expect(result).toBe(false);
    });

    it("should install semgrep in venv", async () => {
        const executedCommands: string[] = [];
        mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            executedCommands.push(cmd);
            // Mock Python version check
            if (cmd.includes('--version')) {
                callback(null, "Python 3.9.0", "");
            } else {
                callback(null, "success", "");
            }
        });

        // Add mkdirSync mock
        mockFs.mkdirSync = mock(() => { });

        // Simulate venv initially missing, then the semgrep binary appearing after install
        mockFs.existsSync.mockImplementation((target: string) => target.includes('/bin/semgrep'));

        await installer.install();

        // Should create venv and install semgrep
        expect(executedCommands.some(cmd => cmd.includes("python3 -m venv"))).toBe(true);
        expect(executedCommands.some(cmd => cmd.includes("pip") && cmd.includes("install semgrep"))).toBe(true);
    });

    it("should skip venv creation if it exists", async () => {
        const executedCommands: string[] = [];
        mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            executedCommands.push(cmd);
            // Mock Python version check
            if (cmd.includes('--version')) {
                callback(null, "Python 3.9.0", "");
            } else {
                callback(null, "success", "");
            }
        });

        // Add mkdirSync mock
        mockFs.mkdirSync = mock(() => { });

        // Simulate venv existing
        mockFs.existsSync.mockImplementation((path: string) => path.includes("semgrep-venv"));

        await installer.install();

        // Should NOT create venv, but SHOULD install semgrep
        expect(executedCommands.some(cmd => cmd.includes("python3 -m venv"))).toBe(false);
        expect(executedCommands.some(cmd => cmd.includes("pip") && cmd.includes("install semgrep"))).toBe(true);
    });

    it("should report incomplete installs when the venv exists without semgrep", () => {
        mockFs.existsSync.mockImplementation((target: string) => target.includes("semgrep-venv") && !target.includes("/bin/semgrep"));

        expect(installer.hasIncompleteInstall()).toBe(true);
    });

    it("should emit install progress messages while repairing an incomplete install", async () => {
        const executedCommands: string[] = [];
        const progressMessages: string[] = [];

        mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            executedCommands.push(cmd);
            if (cmd.includes('--version')) {
                callback(null, "Python 3.9.0", "");
                return;
            }
            callback(null, "success", "");
        });

        mockFs.mkdirSync = mock(() => { });
        mockFs.rmSync = mock(() => { });
        mockFs.existsSync.mockImplementation((target: string) => {
            if (target.includes('/bin/semgrep')) {
                return true;
            }
            if (target.includes('/bin/pip')) {
                return true;
            }
            if (target.includes('semgrep-venv')) {
                return true;
            }
            return false;
        });

        await installer.install((message) => {
            progressMessages.push(message);
        });

        expect(executedCommands.some(cmd => cmd.includes("python3 -m venv"))).toBe(false);
        expect(executedCommands.some(cmd => cmd.includes("pip") && cmd.includes("install semgrep"))).toBe(true);
        expect(progressMessages.some(message => message.includes("Upgrading pip"))).toBe(true);
        expect(progressMessages.some(message => message.includes("Installing Semgrep packages"))).toBe(true);
        expect(progressMessages.at(-1)).toBe("Semgrep is ready.");
    });
});
