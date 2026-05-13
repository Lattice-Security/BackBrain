/**
 * Gemini CLI Installer
 *
 * Handles detection, installation, and authentication of the Gemini CLI
 * tool (@google/gemini-cli) for use as an AI agent review backend.
 *
 * - Detection: checks if `gemini` is on $PATH or was installed globally via npm
 * - Installation: runs `npm install -g @google/gemini-cli`
 * - Authentication: opens an integrated VS Code terminal for interactive Google sign-in
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from '@backbrain/core';

const logger = createLogger('GeminiCliInstaller');

export class GeminiCliInstaller {
    private readonly execFn: typeof cp.exec;
    private cachedBinaryPath: string | null = null;

    constructor(execFn?: typeof cp.exec) {
        this.execFn = execFn || cp.exec;
    }

    /**
     * Check if the Gemini CLI is installed and accessible
     */
    async isInstalled(): Promise<boolean> {
        const binaryPath = await this.resolveBinaryPath();
        return binaryPath !== null;
    }

    /**
     * Get the resolved binary path for Gemini CLI
     * Returns 'gemini' if found on PATH, or the full path if found via npm global
     */
    getBinaryPath(): string {
        return this.cachedBinaryPath || 'gemini';
    }

    /**
     * Check if the Gemini CLI is authenticated.
     *
     * Uses a fast-path: if OAuth credential files exist with a refresh_token,
     * we know the user is authenticated without running an expensive CLI probe.
     * Falls back to a CLI probe only when credential files are missing.
     */
    async isAuthenticated(): Promise<boolean> {
        // Fast-path: check credential files directly
        const credentialStatus = this.checkCredentialFiles();
        if (credentialStatus === 'authenticated') {
            logger.info('Gemini CLI authenticated (credential files present)');
            return true;
        }
        if (credentialStatus === 'no-credentials') {
            logger.info('Gemini CLI not authenticated (no credential files)');
            return false;
        }

        // API key auth — verify with a lightweight probe
        return this.runAuthProbe();
    }

    /**
     * Check credential files for a fast auth determination.
     * Returns 'authenticated' if OAuth creds exist, 'api-key' if GEMINI_API_KEY is set,
     * or 'no-credentials' if neither is found.
     */
    private checkCredentialFiles(): 'authenticated' | 'api-key' | 'no-credentials' {
        // Check for GEMINI_API_KEY environment variable
        if (process.env.GEMINI_API_KEY) {
            return 'api-key';
        }

        // Check for OAuth credential file
        const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        try {
            if (fs.existsSync(credPath)) {
                const raw = fs.readFileSync(credPath, 'utf8');
                const creds = JSON.parse(raw);
                if (creds.refresh_token) {
                    return 'authenticated';
                }
            }
        } catch {
            // Credential file exists but is corrupt/unreadable — fall through
        }

        return 'no-credentials';
    }

    /**
     * Run a lightweight CLI probe to verify auth.
     * Handles rate-limit errors correctly (authenticated but throttled = true).
     */
    private async runAuthProbe(): Promise<boolean> {
        const binaryPath = this.getBinaryPath();
        try {
            const { stdout, stderr } = await this.exec(
                `${this.quotePath(binaryPath)} --approval-mode plan --output-format json -p "Return ONLY this exact JSON: {\\\"ready\\\":true}"`,
                15000,
            );
            const combined = (stdout + stderr).toLowerCase();

            // Rate-limit / capacity errors mean the user IS authenticated
            if (this.isRateLimitError(combined)) {
                logger.info('Gemini CLI is authenticated but rate-limited');
                return true;
            }

            // Check for auth failure indicators
            if (this.isAuthFailure(combined)) {
                logger.info('Gemini CLI is installed but not authenticated');
                return false;
            }

            // Try to parse the response to see if we got valid output
            try {
                const trimmed = stdout.trim();
                if (trimmed) {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.response || parsed.ready === true) {
                        return true;
                    }
                }
            } catch {
                if (stdout.trim().length > 0) {
                    return true;
                }
            }

            return false;
        } catch (error: any) {
            const errorText = [error.message, error.stderr, error.stdout]
                .filter(Boolean)
                .join('\n')
                .toLowerCase();

            // Rate-limit errors mean the user IS authenticated
            if (this.isRateLimitError(errorText)) {
                logger.info('Gemini CLI is authenticated but rate-limited (from error)');
                return true;
            }

            // Timeout is not an auth issue
            if (errorText.includes('timeout') || errorText.includes('timed out')) {
                logger.warn('Gemini CLI auth check timed out — assuming available');
                return true;
            }

            // Auth-related failures
            if (this.isAuthFailure(errorText)) {
                return false;
            }

            logger.warn('Gemini CLI auth check failed with unexpected error', { error });
            return false;
        }
    }

    /**
     * Check if error text indicates a rate-limit (user IS authenticated).
     */
    private isRateLimitError(text: string): boolean {
        return (
            text.includes('429') ||
            text.includes('rate_limit') ||
            text.includes('ratelimitexceeded') ||
            text.includes('resource_exhausted') ||
            text.includes('model_capacity_exhausted') ||
            text.includes('no capacity available') ||
            text.includes('quota')
        );
    }

    /**
     * Check if error text indicates an authentication failure.
     */
    private isAuthFailure(text: string): boolean {
        return (
            text.includes('unauthenticated') ||
            text.includes('sign in') ||
            text.includes('api_key_invalid') ||
            (text.includes('authentication') && !text.includes('authenticated'))
        );
    }

    /**
     * Get the email of the currently authenticated Google account, if any.
     */
    getAuthenticatedAccount(): string | null {
        const accountsPath = path.join(os.homedir(), '.gemini', 'google_accounts.json');
        try {
            if (fs.existsSync(accountsPath)) {
                const raw = fs.readFileSync(accountsPath, 'utf8');
                const accounts = JSON.parse(raw);
                if (accounts.active && typeof accounts.active === 'string') {
                    return accounts.active;
                }
            }
        } catch {
            // Ignore read errors
        }

        // Check for API key auth
        if (process.env.GEMINI_API_KEY) {
            return '(API Key)';
        }

        return null;
    }

    /**
     * Logout from Gemini CLI by clearing cached OAuth credentials.
     */
    async logout(): Promise<void> {
        const geminiDir = path.join(os.homedir(), '.gemini');
        const credPath = path.join(geminiDir, 'oauth_creds.json');
        const accountsPath = path.join(geminiDir, 'google_accounts.json');

        let cleared = false;

        // Remove OAuth credentials
        try {
            if (fs.existsSync(credPath)) {
                fs.unlinkSync(credPath);
                cleared = true;
                logger.info('Removed Gemini CLI OAuth credentials');
            }
        } catch (error) {
            logger.warn('Failed to remove OAuth credentials', { error });
        }

        // Reset accounts file
        try {
            if (fs.existsSync(accountsPath)) {
                fs.writeFileSync(accountsPath, JSON.stringify({ active: null, old: [] }), 'utf8');
                cleared = true;
                logger.info('Reset Gemini CLI accounts file');
            }
        } catch (error) {
            logger.warn('Failed to reset accounts file', { error });
        }

        if (!cleared) {
            logger.info('No Gemini CLI credentials to clear');
        }
    }

    /**
     * Install Gemini CLI globally via npm.
     * Returns the path to the installed binary.
     */
    async install(): Promise<string> {
        logger.info('Installing Gemini CLI via npm...');

        // First check if npm is available
        try {
            await this.exec('npm --version', 10000);
        } catch {
            throw new Error(
                'npm is not available. Please install Node.js (v20+) and npm first, then retry.',
            );
        }

        // Install globally
        try {
            await this.exec('npm install -g @google/gemini-cli', 120000);
            logger.info('Gemini CLI installed successfully via npm');
        } catch (error: any) {
            const errorMsg = error.message || String(error);

            // Check for common permission issues
            if (errorMsg.includes('EACCES') || errorMsg.includes('permission denied')) {
                throw new Error(
                    'Permission denied installing Gemini CLI. Try using a Node version manager (nvm/fnm) or configure npm prefix.',
                );
            }

            throw new Error(`Failed to install Gemini CLI: ${errorMsg}`);
        }

        // Verify installation and resolve the path
        const binaryPath = await this.resolveBinaryPath();
        if (!binaryPath) {
            throw new Error(
                'Gemini CLI was installed but could not be found. You may need to restart your terminal.',
            );
        }

        this.cachedBinaryPath = binaryPath;
        return binaryPath;
    }

    /**
     * Open an integrated VS Code terminal for the user to authenticate with Gemini CLI.
     * This launches `gemini` interactively so the user can complete the Google sign-in flow.
     */
    async loginViaTerminal(): Promise<vscode.Terminal> {
        const binaryPath = this.getBinaryPath();

        // Create a dedicated terminal for Gemini login
        const terminal = vscode.window.createTerminal({
            name: 'BackBrain: Gemini Login',
            message: '🔐 Authenticating with Gemini CLI...\nComplete the sign-in flow below, then close this terminal.',
            iconPath: new vscode.ThemeIcon('key'),
        });

        terminal.show();
        terminal.sendText(`${binaryPath} auth`, true);

        logger.info('Opened Gemini CLI login terminal');
        return terminal;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    /**
     * Try to find the `gemini` binary on PATH or in common npm global locations
     */
    private async resolveBinaryPath(): Promise<string | null> {
        // 1. Try `gemini --version` directly (on PATH)
        try {
            await this.exec('gemini --version', 10000);
            this.cachedBinaryPath = 'gemini';
            return 'gemini';
        } catch {
            // Not on PATH, continue
        }

        // 2. Check common npm global install locations
        const candidates = this.getNpmGlobalCandidates();
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                try {
                    await this.exec(`${this.quotePath(candidate)} --version`, 10000);
                    this.cachedBinaryPath = candidate;
                    logger.info('Found Gemini CLI at npm global path', { path: candidate });
                    return candidate;
                } catch {
                    // Binary exists but doesn't work, skip
                }
            }
        }

        // 3. Try `npx --yes gemini --version` as last resort check
        try {
            await this.exec('npx --yes @google/gemini-cli --version', 30000);
            // npx works, but we want a stable path — try to find the real binary
            const npmRoot = await this.getNpmGlobalRoot();
            if (npmRoot) {
                const npxBinary = path.join(npmRoot, '.bin', 'gemini');
                if (fs.existsSync(npxBinary)) {
                    this.cachedBinaryPath = npxBinary;
                    return npxBinary;
                }
            }
            // Fall back to just using `gemini` via npx path resolution
            this.cachedBinaryPath = 'npx --yes @google/gemini-cli';
            return this.cachedBinaryPath;
        } catch {
            // Not available at all
        }

        return null;
    }

    /**
     * Get common npm global binary locations based on the platform
     */
    private getNpmGlobalCandidates(): string[] {
        const home = os.homedir();
        const candidates: string[] = [];

        if (process.platform === 'win32') {
            // Windows: npm global installs to AppData/Roaming/npm
            const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
            candidates.push(path.join(appData, 'npm', 'gemini.cmd'));
            candidates.push(path.join(appData, 'npm', 'gemini'));
        } else {
            // macOS/Linux
            candidates.push(path.join(home, '.npm-global', 'bin', 'gemini'));
            candidates.push(path.join(home, '.nvm', 'versions', 'node', '*', 'bin', 'gemini'));
            candidates.push('/usr/local/bin/gemini');
            candidates.push('/usr/bin/gemini');

            // fnm / volta paths
            candidates.push(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'gemini'));
            candidates.push(path.join(home, '.volta', 'bin', 'gemini'));

            // Bun global
            candidates.push(path.join(home, '.bun', 'bin', 'gemini'));
        }

        return candidates;
    }

    /**
     * Get the npm global root directory
     */
    private async getNpmGlobalRoot(): Promise<string | null> {
        try {
            const { stdout } = await this.exec('npm root -g', 10000);
            const root = stdout.trim();
            if (root && fs.existsSync(root)) {
                return path.dirname(root); // npm root -g returns the lib dir, we want the parent
            }
        } catch {
            // Ignore
        }
        return null;
    }

    private quotePath(filePath: string): string {
        if (process.platform === 'win32') {
            return `"${filePath.replace(/"/g, '\\"')}"`;
        }
        return `'${filePath.replace(/'/g, "'\\''")}'`;
    }

    private exec(command: string, timeout = 30000): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            this.execFn(command, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    // Attach stdout/stderr to the error for diagnostic classification
                    (error as any).stdout = stdout;
                    (error as any).stderr = stderr;
                    reject(error);
                    return;
                }
                resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
            });
        });
    }
}
