import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '@backbrain/core';

const logger = createLogger('GitHubCliInstaller');

type SupportedPlatform = NodeJS.Platform;

interface GitHubReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    assets: GitHubReleaseAsset[];
}

interface ToolDescriptor {
    id: string;
    displayName: string;
    binaryName: string;
    repo: string;
    docsUrl: string;
    assetPatterns: Partial<Record<SupportedPlatform, RegExp[]>>;
    binaryCandidates?: string[];
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
    gitleaks: {
        id: 'gitleaks',
        displayName: 'Gitleaks',
        binaryName: 'gitleaks',
        repo: 'gitleaks/gitleaks',
        docsUrl: 'https://github.com/gitleaks/gitleaks',
        assetPatterns: {
            linux: [/linux_x64\.tar\.gz$/i, /linux_amd64\.tar\.gz$/i],
            darwin: [/darwin_x64\.tar\.gz$/i, /darwin_amd64\.tar\.gz$/i, /darwin_arm64\.tar\.gz$/i],
            win32: [/windows_x64\.zip$/i, /windows_amd64\.zip$/i],
        },
        binaryCandidates: ['gitleaks', 'gitleaks.exe'],
    },
    trivy: {
        id: 'trivy',
        displayName: 'Trivy',
        binaryName: 'trivy',
        repo: 'aquasecurity/trivy',
        docsUrl: 'https://github.com/aquasecurity/trivy',
        assetPatterns: {
            linux: [/Linux-64bit\.tar\.gz$/i, /linux-64bit\.tar\.gz$/i],
            darwin: [/macOS-64bit\.tar\.gz$/i, /macos-64bit\.tar\.gz$/i, /macOS-ARM64\.tar\.gz$/i, /macos-arm64\.tar\.gz$/i],
            win32: [/Windows-64bit\.zip$/i, /windows-64bit\.zip$/i],
        },
        binaryCandidates: ['trivy', 'trivy.exe'],
    },
    'osv-scanner': {
        id: 'osv-scanner',
        displayName: 'OSV-Scanner',
        binaryName: 'osv-scanner',
        repo: 'google/osv-scanner',
        docsUrl: 'https://github.com/google/osv-scanner',
        assetPatterns: {
            linux: [/linux_amd64/i, /linux_x86_64/i],
            darwin: [/darwin_amd64/i, /darwin_arm64/i],
            win32: [/windows_amd64.*\.exe$/i, /windows_x86_64.*\.exe$/i, /windows_amd64.*\.zip$/i],
        },
        binaryCandidates: [
            'osv-scanner', 
            'osv-scanner.exe',
            'osv-scanner_linux_amd64',
            'osv-scanner_linux_x86_64',
            'osv-scanner_darwin_amd64',
            'osv-scanner_darwin_arm64',
            'osv-scanner_windows_amd64.exe',
            'osv-scanner_windows_x86_64.exe'
        ],
    },
};

type ToolId = keyof typeof TOOL_DESCRIPTORS;

export class GitHubCliInstaller {
    private readonly execFn: typeof cp.exec;
    private readonly fs: typeof fs;

    constructor(execFn?: typeof cp.exec, fileSystem?: typeof fs) {
        this.execFn = execFn || cp.exec;
        this.fs = fileSystem || fs;
    }

    async isAvailable(toolId: ToolId): Promise<boolean> {
        const descriptor = this.getDescriptor(toolId);
        try {
            await this.exec(`${this.quotePath(this.getBinaryPath(toolId))} --version`);
            return true;
        } catch {
            try {
                await this.exec(`${descriptor.binaryName} --version`);
                return true;
            } catch {
                return false;
            }
        }
    }

    getBinaryPath(toolId: ToolId): string {
        const markerPath = this.getMarkerPath(toolId);
        if (this.fs.existsSync(markerPath)) {
            const binaryPath = this.fs.readFileSync(markerPath, 'utf8').trim();
            if (binaryPath && this.fs.existsSync(binaryPath)) {
                return binaryPath;
            }
        }
        return this.getDescriptor(toolId).binaryName;
    }

    async install(toolId: ToolId): Promise<string> {
        const descriptor = this.getDescriptor(toolId);
        logger.info('Installing external CLI tool', { tool: descriptor.id });

        const release = await this.fetchLatestRelease(descriptor.repo);
        const asset = this.selectAsset(descriptor, release);
        if (!asset) {
            throw new Error(`No compatible release asset found for ${descriptor.displayName} on ${process.platform}.`);
        }

        const toolRoot = this.getToolRoot(toolId);
        const versionDir = path.join(toolRoot, release.tag_name);
        const archivePath = path.join(versionDir, asset.name);
        this.fs.mkdirSync(versionDir, { recursive: true });

        await this.downloadFile(asset.browser_download_url, archivePath);
        await this.extractArchive(archivePath, versionDir);

        const binaryPath = this.findBinary(versionDir, descriptor.binaryCandidates || [descriptor.binaryName]);
        if (!binaryPath) {
            throw new Error(`Installed ${descriptor.displayName}, but could not find its executable.`);
        }

        if (process.platform !== 'win32') {
            this.fs.chmodSync(binaryPath, 0o755);
        }
        this.fs.writeFileSync(this.getMarkerPath(toolId), binaryPath, 'utf8');
        logger.info('Installed external CLI tool', { tool: descriptor.id, binaryPath });
        return binaryPath;
    }

    getDocsUrl(toolId: ToolId): string {
        return this.getDescriptor(toolId).docsUrl;
    }

    getDisplayName(toolId: ToolId): string {
        return this.getDescriptor(toolId).displayName;
    }

    private selectAsset(descriptor: ToolDescriptor, release: GitHubRelease): GitHubReleaseAsset | undefined {
        const patterns = descriptor.assetPatterns[process.platform];
        if (!patterns || patterns.length === 0) {
            return undefined;
        }

        return release.assets.find(asset => patterns.some(pattern => pattern.test(asset.name)));
    }

    private findBinary(rootDir: string, candidates: string[]): string | undefined {
        const entries = this.fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                const nested = this.findBinary(fullPath, candidates);
                if (nested) return nested;
                continue;
            }

            if (candidates.includes(entry.name)) {
                return fullPath;
            }
        }
        return undefined;
    }

    private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
        if (archivePath.endsWith('.tar.gz')) {
            await this.exec(`tar -xzf ${this.quotePath(archivePath)} -C ${this.quotePath(targetDir)}`);
            return;
        }

        if (archivePath.endsWith('.zip')) {
            await this.exec(`unzip -o ${this.quotePath(archivePath)} -d ${this.quotePath(targetDir)}`);
            return;
        }

        // Not an archive — treat the downloaded file as a bare executable.
        // Mark it executable so findBinary() can locate it.
        if (process.platform !== 'win32') {
            this.fs.chmodSync(archivePath, 0o755);
        }
    }

    private async fetchLatestRelease(repo: string): Promise<GitHubRelease> {
        const url = `https://api.github.com/repos/${repo}/releases/latest`;
        const body = await this.fetchText(url);
        return JSON.parse(body) as GitHubRelease;
    }

    private async downloadFile(url: string, destination: string): Promise<void> {
        const data = await this.fetchBuffer(url);
        this.fs.writeFileSync(destination, data);
    }

    private fetchText(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.request(url, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            }, reject);
        });
    }

    private fetchBuffer(url: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            this.request(url, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }, reject);
        });
    }

    private request(
        url: string,
        onResponse: (res: import('http').IncomingMessage) => void,
        onError: (error: Error) => void,
    ): void {
        https.get(url, {
            headers: {
                'User-Agent': 'BackBrain',
                'Accept': 'application/vnd.github+json',
            },
        }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                this.request(res.headers.location, onResponse, onError);
                return;
            }

            if (!res.statusCode || res.statusCode >= 400) {
                onError(new Error(`Request failed for ${url} with status ${res.statusCode || 'unknown'}`));
                return;
            }

            onResponse(res);
        }).on('error', onError);
    }

    private getToolRoot(toolId: ToolId): string {
        return path.join(os.homedir(), '.backbrain', 'tools', toolId);
    }

    private getMarkerPath(toolId: ToolId): string {
        return path.join(this.getToolRoot(toolId), 'current-path.txt');
    }

    private getDescriptor(toolId: ToolId): ToolDescriptor {
        return TOOL_DESCRIPTORS[toolId]!;
    }

    private quotePath(filePath: string): string {
        const isWin = process.platform === 'win32';
        if (isWin) {
            return `"${filePath.replace(/"/g, '\\"')}"`;
        }
        return `'${filePath.replace(/'/g, "'\\''")}'`;
    }

    private exec(command: string, timeout = 120000): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            this.execFn(command, { timeout, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });
    }
}
