import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@backbrain/core';

const logger = createLogger('SemgrepInstaller');

export type SemgrepInstallProgressCallback = (message: string) => void;

export class SemgrepInstaller {
    private execFn: typeof cp.exec;
    private fs: typeof fs;

    constructor(
        _context: vscode.ExtensionContext,
        execFn?: typeof cp.exec,
        fileSystem?: typeof fs
    ) {
        this.execFn = execFn || cp.exec;
        this.fs = fileSystem || fs;
    }

    /**
     * Escape and quote a path for shell execution
     */
    private quotePath(filePath: string): string {
        const isWin = process.platform === 'win32';
        if (isWin) {
            // Windows: Use double quotes and escape internal quotes
            return `"${filePath.replace(/"/g, '\\"')}"`;
        } else {
            // Unix: Use single quotes and escape single quotes
            return `'${filePath.replace(/'/g, "'\\''")}'`;
        }
    }

    /**
     * Check if Semgrep is installed and available
     */
    public async isAvailable(): Promise<boolean> {
        try {
            // First check if we have it in our private venv
            const venvSemgrep = this.getVenvSemgrepPath();
            if (this.fs.existsSync(venvSemgrep)) {
                // Verify it actually works
                try {
                    await this.exec(`${this.quotePath(venvSemgrep)} --version`);
                    logger.debug('Found working Semgrep in private venv', { path: venvSemgrep });
                    return true;
                } catch {
                    logger.warn('Semgrep binary exists but is not functional', { path: venvSemgrep });
                    // Fall through to check global
                }
            }

            // Then check global path
            await this.exec('semgrep --version');
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get the path to the Semgrep executable (venv or global)
     */
    public getSemgrepPath(): string {
        const venvSemgrep = this.getVenvSemgrepPath();
        if (this.fs.existsSync(venvSemgrep)) {
            return venvSemgrep;
        }
        return 'semgrep'; // Fallback to global
    }

    /**
     * Check if Python is available on the system
     */
    private async checkPythonAvailability(): Promise<string> {
        const candidates = ['python3', 'python'];
        
        for (const cmd of candidates) {
            try {
                await this.exec(`${cmd} --version`);
                return cmd;
            } catch {
                continue;
            }
        }
        
        const isWin = process.platform === 'win32';
        const installUrl = isWin 
            ? 'https://www.python.org/downloads/windows/'
            : 'https://www.python.org/downloads/';
        
        throw new Error(
            `Python is not installed or not in PATH. Please install Python 3.7+ from ${installUrl}`
        );
    }

    /**
     * Check if Python version meets minimum requirements (3.7+)
     */
    private async checkPythonVersion(pythonCmd: string): Promise<void> {
        const { stdout } = await this.exec(`${pythonCmd} --version`);
        const versionMatch = stdout.match(/(\d+)\.(\d+)/);

        if (!versionMatch) {
            throw new Error('Could not determine Python version');
        }

        const major = parseInt(versionMatch[1]!, 10);
        const minor = parseInt(versionMatch[2]!, 10);

        if (major < 3 || (major === 3 && minor < 7)) {
            throw new Error(
                `Python ${major}.${minor} is not supported. Semgrep requires Python 3.7 or higher. Please upgrade Python.`
            );
        }

        logger.info(`Python version check passed: ${major}.${minor}`);
    }

    /**
     * Install Semgrep into a private virtual environment
     */
    public async install(onProgress?: SemgrepInstallProgressCallback): Promise<void> {
        logger.info('Starting Semgrep installation...');
        const venvPath = this.getVenvPath();
        let venvCreated = false;

        try {
            this.reportProgress(onProgress, 'Checking Python runtime...');
            // 1. Check Python availability and version
            const pythonCmd = await this.checkPythonAvailability();
            await this.checkPythonVersion(pythonCmd);

            const installState = this.getInstallState();
            if (installState.venvExists && !installState.semgrepExists) {
                this.reportProgress(onProgress, 'Found incomplete Semgrep install. Repairing it...');
                logger.warn('Detected incomplete Semgrep install', installState);
            }

            if (installState.venvExists && !installState.pipExists) {
                this.reportProgress(onProgress, 'Recreating broken Python environment...');
                logger.warn('Detected broken Semgrep venv missing pip, recreating', installState);
                this.removeVenv(venvPath);
            }

            // 2. Ensure ~/.backbrain directory exists (handle permissions)
            const backbrainDir = path.dirname(venvPath);
            if (!this.fs.existsSync(backbrainDir)) {
                try {
                    this.fs.mkdirSync(backbrainDir, { recursive: true });
                } catch (err) {
                    const error = err as NodeJS.ErrnoException;
                    if (error.code === 'EACCES' || error.code === 'EPERM') {
                        throw new Error(
                            `Permission denied creating ${backbrainDir}. Please run with appropriate permissions.`
                        );
                    }
                    throw new Error(
                        `Cannot create directory ${backbrainDir}: ${error.message}`
                    );
                }
            }

            // 3. Create venv if it doesn't exist
            if (!this.fs.existsSync(venvPath)) {
                this.reportProgress(onProgress, 'Creating isolated Python environment...');
                logger.info('Creating virtual environment', { venvPath });
                try {
                    await this.exec(`${pythonCmd} -m venv ${this.quotePath(venvPath)}`);
                    venvCreated = true;
                } catch (err) {
                    const error = err as Error;
                    throw new Error(
                        `Failed to create Python virtual environment: ${error.message}. ` +
                        `Ensure 'python3-venv' package is installed on Linux.`
                    );
                }
            }

            // 4. Upgrade pip first (prevents many installation issues)
            const pipPath = this.getVenvPipPath();
            this.reportProgress(onProgress, 'Upgrading pip...');
            logger.info('Upgrading pip', { pipPath });
            try {
                await this.exec(`${this.quotePath(pipPath)} install --upgrade pip`);
            } catch (err) {
                logger.warn('Failed to upgrade pip, continuing anyway', { error: err });
            }

            // 5. Install semgrep with retry logic
            this.reportProgress(onProgress, 'Installing Semgrep packages (this can take a minute)...');
            logger.info('Installing semgrep via pip', { pipPath });

            const maxRetries = 3;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    await this.exec(`${this.quotePath(pipPath)} install semgrep`, 120000); // 2 min timeout
                    logger.info('Semgrep installed successfully');
                    break;
                } catch (err) {
                    lastError = err as Error;
                    logger.warn(`Installation attempt ${attempt} failed`, { error: err });

                    if (attempt < maxRetries) {
                        this.reportProgress(onProgress, `Install attempt ${attempt} failed. Retrying...`);
                        logger.info(`Retrying in 2 seconds... (${attempt}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }

            if (lastError) {
                const errorMsg = lastError.message.toLowerCase();
                if (errorMsg.includes('network') || errorMsg.includes('connection')) {
                    throw new Error(
                        `Network error during installation. Please check your internet connection and try again.`
                    );
                } else if (errorMsg.includes('permission')) {
                    throw new Error(
                        `Permission error during installation. Try running with appropriate permissions.`
                    );
                } else {
                    throw new Error(
                        `Failed to install Semgrep after ${maxRetries} attempts: ${lastError.message}`
                    );
                }
            }

            // 6. Verify installation
            const semgrepPath = this.getVenvSemgrepPath();
            this.reportProgress(onProgress, 'Verifying Semgrep installation...');
            if (!this.fs.existsSync(semgrepPath)) {
                throw new Error(
                    `Semgrep binary not found after installation at ${semgrepPath}. Installation may have failed silently.`
                );
            }

            try {
                await this.exec(`${this.quotePath(semgrepPath)} --version`);
                logger.info('Semgrep installation verified successfully');
            } catch (err) {
                throw new Error(
                    `Semgrep installed but is not functional. Try reinstalling or install manually from https://semgrep.dev/docs/getting-started/`
                );
            }

            this.reportProgress(onProgress, 'Semgrep is ready.');

        } catch (error) {
            logger.error('Semgrep installation failed', { error });
            
            // Cleanup on failure if we created the venv
            if (venvCreated && this.fs.existsSync(venvPath)) {
                logger.info('Cleaning up failed installation', { venvPath });
                try {
                    this.fs.rmSync(venvPath, { recursive: true, force: true });
                } catch (cleanupErr) {
                    logger.warn('Failed to cleanup venv after installation failure', { error: cleanupErr });
                }
            }
            
            throw error;
        }
    }

    public hasIncompleteInstall(): boolean {
        const state = this.getInstallState();
        return state.venvExists && !state.semgrepExists;
    }

    private getVenvPath(): string {
        // Use a hidden folder in the user's home directory for persistence across sessions
        // and to avoid cluttering the workspace
        return path.join(os.homedir(), '.backbrain', 'semgrep-venv');
    }

    private getVenvSemgrepPath(): string {
        const venv = this.getVenvPath();
        const isWin = process.platform === 'win32';
        return isWin
            ? path.join(venv, 'Scripts', 'semgrep.exe')
            : path.join(venv, 'bin', 'semgrep');
    }

    private getVenvPipPath(): string {
        const venv = this.getVenvPath();
        const isWin = process.platform === 'win32';
        return isWin
            ? path.join(venv, 'Scripts', 'pip.exe')
            : path.join(venv, 'bin', 'pip');
    }

    private getInstallState(): { venvExists: boolean; pipExists: boolean; semgrepExists: boolean } {
        const venvPath = this.getVenvPath();
        const pipPath = this.getVenvPipPath();
        const semgrepPath = this.getVenvSemgrepPath();

        return {
            venvExists: this.fs.existsSync(venvPath),
            pipExists: this.fs.existsSync(pipPath),
            semgrepExists: this.fs.existsSync(semgrepPath),
        };
    }

    private removeVenv(venvPath: string): void {
        if (!this.fs.existsSync(venvPath)) {
            return;
        }
        this.fs.rmSync(venvPath, { recursive: true, force: true });
    }

    private reportProgress(callback: SemgrepInstallProgressCallback | undefined, message: string): void {
        logger.info(message);
        callback?.(message);
    }

    private exec(command: string, timeout: number = 30000): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            this.execFn(command, { timeout, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }
}
