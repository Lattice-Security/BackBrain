import * as fs from 'fs/promises';
import * as path from 'path';

export interface FixFileChange {
    filePath: string;
    originalContent: string;
    newContent: string;
}

export interface FixSessionRecord {
    sessionId: string;
    timestamp: string;
    scanId?: string;
    summary: {
        totalIssues: number;
        fixed: number;
        skipped: number;
        failed: number;
    };
    changes: FixFileChange[];
}

export class FixSessionStore {
    private historyDir: string;

    constructor(rootDir: string) {
        this.historyDir = path.join(rootDir, '.backbrain', 'fix-history');
    }

    async save(session: FixSessionRecord): Promise<void> {
        await fs.mkdir(this.historyDir, { recursive: true });
        await fs.writeFile(
            path.join(this.historyDir, `${session.sessionId}.json`),
            JSON.stringify(session, null, 2),
            'utf-8',
        );
    }

    async load(sessionId: string): Promise<FixSessionRecord | null> {
        try {
            const content = await fs.readFile(
                path.join(this.historyDir, `${sessionId}.json`),
                'utf-8',
            );
            return JSON.parse(content) as FixSessionRecord;
        } catch {
            return null;
        }
    }

    async list(): Promise<{ sessionId: string; timestamp: string; fixed: number; total: number }[]> {
        try {
            const files = await fs.readdir(this.historyDir);
            const entries = await Promise.all(
                files
                    .filter(f => f.endsWith('.json'))
                    .map(async (f) => {
                        try {
                            const content = await fs.readFile(path.join(this.historyDir, f), 'utf-8');
                            const record = JSON.parse(content) as FixSessionRecord;
                            return {
                                sessionId: record.sessionId,
                                timestamp: record.timestamp,
                                fixed: record.summary.fixed,
                                total: record.summary.totalIssues,
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

    async delete(sessionId: string): Promise<void> {
        try {
            await fs.unlink(path.join(this.historyDir, `${sessionId}.json`));
        } catch {
            // ignore
        }
    }
}
