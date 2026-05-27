import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodeIssue, IssueSeverity, IssueCategory } from '../types';
import type { SecurityScanResult } from './security-service';

export interface ScannerRunRecord {
    name: string;
    available: boolean;
    succeeded: boolean;
    issuesFound: number;
    error?: string;
}

export interface ScanRecord {
    scanId: string;
    timestamp: string;
    durationMs: number;
    cliArgs?: string[];
    scanners: ScannerRunRecord[];
    filesScanned: number;
    summary: {
        total: number;
        bySeverity: Record<IssueSeverity, number>;
        byCategory: Record<IssueCategory, number>;
        riskScore: number;
    };
    issues: CodeIssue[];
    errors: { scanner: string; message: string }[];
}

export class ScanResultStore {
    readonly scanDir: string;
    private historyDir: string;
    private scanErrors: { scanner: string; message: string }[] = [];

    constructor(rootDir: string) {
        this.scanDir = path.join(rootDir, '.backbrain');
        this.historyDir = path.join(this.scanDir, 'scan-history');
    }

    get basePath(): string {
        return this.scanDir;
    }

    addError(scanner: string, message: string): void {
        this.scanErrors.push({ scanner, message });
    }

    get errors(): readonly { scanner: string; message: string }[] {
        return this.scanErrors;
    }

    clearErrors(): void {
        this.scanErrors = [];
    }

    async save(result: SecurityScanResult): Promise<ScanRecord> {
        const bySeverity: Record<string, number> = {
            critical: 0, high: 0, medium: 0, low: 0, info: 0,
        };
        const byCategory: Record<string, number> = {};

        for (const issue of result.issues) {
            bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
            byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
        }

        const riskScore = this.calculateRiskScore(bySeverity);

        const record: ScanRecord = {
            scanId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            timestamp: new Date().toISOString(),
            durationMs: result.scanDurationMs,
            filesScanned: result.scannedFiles.length,
            scanners: [],
            summary: {
                total: result.issues.length,
                bySeverity: bySeverity as Record<IssueSeverity, number>,
                byCategory: byCategory as Record<IssueCategory, number>,
                riskScore,
            },
            issues: result.issues,
            errors: [...this.scanErrors],
        };

        await fs.mkdir(this.historyDir, { recursive: true });

        await Promise.all([
            fs.writeFile(
                path.join(this.scanDir, 'last-scan.json'),
                JSON.stringify(record, null, 2),
                'utf-8',
            ),
            fs.writeFile(
                path.join(this.historyDir, `${record.scanId}.json`),
                JSON.stringify(record, null, 2),
                'utf-8',
            ),
        ]);

        return record;
    }

    async loadLast(): Promise<ScanRecord | null> {
        try {
            const content = await fs.readFile(path.join(this.scanDir, 'last-scan.json'), 'utf-8');
            return JSON.parse(content) as ScanRecord;
        } catch {
            return null;
        }
    }

    async listHistory(): Promise<{ scanId: string; timestamp: string; total: number }[]> {
        try {
            const files = await fs.readdir(this.historyDir);
            const entries = await Promise.all(
                files
                    .filter(f => f.endsWith('.json'))
                    .map(async (f) => {
                        try {
                            const content = await fs.readFile(path.join(this.historyDir, f), 'utf-8');
                            const record = JSON.parse(content) as ScanRecord;
                            return {
                                scanId: record.scanId,
                                timestamp: record.timestamp,
                                total: record.summary.total,
                            };
                        } catch {
                            return null;
                        }
                    }),
            );
            return entries
                .filter((e): e is NonNullable<typeof e> => e !== null)
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        } catch {
            return [];
        }
    }

    async loadScan(scanId: string): Promise<ScanRecord | null> {
        try {
            const content = await fs.readFile(
                path.join(this.historyDir, `${scanId}.json`),
                'utf-8',
            );
            return JSON.parse(content) as ScanRecord;
        } catch {
            return null;
        }
    }

    private calculateRiskScore(counts: Record<string, number>): number {
        const W_CRITICAL = 10;
        const W_HIGH = 5;
        const W_MEDIUM = 2;
        const W_LOW = 1;

        const totalWeight =
            (counts.critical || 0) * W_CRITICAL +
            (counts.high || 0) * W_HIGH +
            (counts.medium || 0) * W_MEDIUM +
            (counts.low || 0) * W_LOW;

        return Math.min(100, Math.round((totalWeight / 50) * 100));
    }
}
