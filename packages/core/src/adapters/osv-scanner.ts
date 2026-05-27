import { exec } from 'child_process';
import * as nodePath from 'path';
import type { ScanResult, SecurityIssue, Severity } from '../ports';
import { createLogger } from '../utils/logger';
import { toError } from '../utils/result';
import { CliScannerBase } from './cli-scanner-base';

const logger = createLogger('OSVScanner');

interface OsvVulnerability {
    id?: string;
    summary?: string;
    details?: string;
    database_specific?: {
        severity?: string;
    };
}

interface OsvResult {
    source?: {
        path?: string;
    };
    packages?: Array<{
        package?: { name?: string };
        vulnerabilities?: OsvVulnerability[];
    }>;
    vulnerabilities?: OsvVulnerability[];
}

interface OsvOutput {
    results?: OsvResult[];
}

/** Lockfile/manifest extensions that osv-scanner can analyze */
const OSV_FILE_EXTENSIONS = [
    '.lock', '.json', '.toml', '.yaml', '.yml', '.txt',
];

/** Lockfile basenames osv-scanner recognizes */
const OSV_LOCKFILE_NAMES = [
    'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml',
    'Gemfile.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock',
    'composer.lock', 'pubspec.lock', 'requirements.txt', 'gradle.lockfile',
    'packages.lock.json', 'pdm.lock', 'uv.lock',
];

export class OSVScanner extends CliScannerBase {
    readonly name = 'osv-scanner';

    /** Cached CLI version: 1 = legacy, 2 = v2+ subcommand style */
    private cliVersion: 1 | 2 | undefined;

    constructor(execFn?: typeof import('child_process').exec, binaryPath = 'osv-scanner') {
        super(binaryPath, execFn);
    }

    async isAvailable(): Promise<boolean> {
        return this.checkAvailable('--version');
    }

    getSupportedExtensions(): string[] {
        return OSV_FILE_EXTENSIONS;
    }

    async scanFile(filePath: string): Promise<SecurityIssue[]> {
        // Only scan recognized lockfile/manifest files
        const basename = nodePath.basename(filePath).toLowerCase();
        const ext = nodePath.extname(filePath).toLowerCase();
        const isLockfile = OSV_LOCKFILE_NAMES.includes(basename) || OSV_FILE_EXTENSIONS.includes(ext);

        if (!isLockfile) {
            // Not a dependency file — nothing for osv-scanner to do
            return [];
        }

        const result = await this.scan([filePath]);
        return result.issues.filter(issue => issue.filePath === filePath);
    }

    async scan(paths: string[]): Promise<ScanResult> {
        const startTime = Date.now();

        try {
            const issues: SecurityIssue[] = [];
            const version = await this.detectCliVersion();

            for (const scanPath of paths) {
                const command = version === 2
                    ? this.buildV2Command(scanPath)
                    : this.buildV1Command(scanPath);

                const stdout = await this.execOsv(command);

                if (!stdout || !stdout.trim()) {
                    // No output means no vulnerabilities found
                    continue;
                }

                const data = JSON.parse(stdout) as OsvOutput;
                for (const result of data.results || []) {
                    const directVulns = result.vulnerabilities || [];
                    for (const vuln of directVulns) {
                        issues.push(this.toIssue(scanPath, vuln));
                    }

                    for (const pkg of result.packages || []) {
                        for (const vuln of pkg.vulnerabilities || []) {
                            issues.push(this.toIssue(result.source?.path || scanPath, vuln, pkg.package?.name));
                        }
                    }
                }
            }

            return {
                issues,
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: 'OSV-Scanner',
            };
        } catch (error) {
            logger.error('OSV scan failed', { error: toError(error) });
            throw error;
        }
    }

    /**
     * Build the scan command for osv-scanner v2.x.
     * v2 syntax: osv-scanner scan source --format json [-r <dir>] [-L <lockfile>]
     */
    private buildV2Command(scanPath: string): string {
        const ext = nodePath.extname(scanPath).toLowerCase();
        const basename = nodePath.basename(scanPath).toLowerCase();

        // If the path looks like a lockfile, scan it directly with -L
        const isLockfile = OSV_LOCKFILE_NAMES.includes(basename) || ['.lock', '.lockb'].includes(ext);
        if (isLockfile) {
            return `${this.binaryPath} scan source --format json -L ${this.quote(scanPath)}`;
        }

        // Otherwise treat it as a directory to scan recursively
        return `${this.binaryPath} scan source --format json -r ${this.quote(scanPath)}`;
    }

    /**
     * Build the scan command for osv-scanner v1.x (legacy).
     * v1 syntax: osv-scanner --format json <path>
     */
    private buildV1Command(scanPath: string): string {
        return `${this.binaryPath} --format json ${this.quote(scanPath)}`;
    }

    /**
     * Detect whether the installed osv-scanner uses v1 or v2 CLI.
     * v2 has the "scan" subcommand; v1 uses top-level flags.
     */
    private async detectCliVersion(): Promise<1 | 2> {
        if (this.cliVersion !== undefined) {
            return this.cliVersion;
        }

        try {
            const stdout = await this.execOsv(`${this.binaryPath} --version`);
            // v2 output contains "osv-scanner version: 2.x.x"
            const match = stdout.match(/version:\s*(\d+)/i);
            if (match && parseInt(match[1] ?? '0', 10) >= 2) {
                this.cliVersion = 2;
            } else {
                // Also try running "scan --help" to detect v2
                try {
                    await this.execOsv(`${this.binaryPath} scan --help`);
                    this.cliVersion = 2;
                } catch {
                    this.cliVersion = 1;
                }
            }
        } catch {
            // Default to v2 since that's the current release
            this.cliVersion = 2;
        }

        logger.info(`Detected osv-scanner CLI version: ${this.cliVersion}`);
        return this.cliVersion;
    }

    /**
     * Execute osv-scanner and return stdout.
     * osv-scanner uses special exit codes:
     *   0   = no vulnerabilities found
     *   1   = vulnerabilities found (stdout still has valid JSON)
     *   128+ = real error
     * Node's exec rejects on any non-zero exit, so we catch exit code 1
     * and extract the valid stdout from the error object.
     */
    private execOsv(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            (this.execFn || exec)(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, _stderr) => {
                if (!error) {
                    // Exit 0: no vulnerabilities
                    resolve(typeof stdout === 'string' ? stdout : '');
                    return;
                }

                // If we got valid stdout despite an error, use it.
                // This handles exit code 1 (vulns found) and other cases
                // where osv-scanner writes valid JSON to stdout before exiting.
                if (stdout && typeof stdout === 'string' && stdout.trim().length > 0) {
                    resolve(stdout);
                    return;
                }

                reject(error);
            });
        });
    }

    private toIssue(filePath: string, vulnerability: OsvVulnerability, packageName?: string): SecurityIssue {
        return {
            ruleId: vulnerability.id || 'osv.vulnerability',
            title: vulnerability.summary || vulnerability.id || 'Dependency vulnerability',
            description: vulnerability.details || (packageName ? `Known vulnerability in ${packageName}.` : 'Known dependency vulnerability detected by OSV-Scanner.'),
            severity: this.mapSeverity(vulnerability.database_specific?.severity),
            filePath,
            line: 1,
        };
    }

    private mapSeverity(value?: string): Severity {
        switch ((value || '').toLowerCase()) {
            case 'critical':
                return 'critical';
            case 'high':
                return 'high';
            case 'medium':
                return 'medium';
            case 'low':
                return 'low';
            default:
                return 'info';
        }
    }
}
