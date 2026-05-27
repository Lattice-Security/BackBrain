import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry, LogOutput } from './logger';

const LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'] as const;

export class FileLogOutput {
    private stream: fs.WriteStream;

    constructor(filePath: string) {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    }

    write(entry: LogEntry): void {
        const line = JSON.stringify({
            level: LEVEL_NAMES[entry.level],
            message: entry.message,
            timestamp: entry.timestamp.toISOString(),
            ...(entry.context ? { context: entry.context } : {}),
        });
        this.stream.write(line + '\n');
    }

    get handler(): LogOutput {
        return (entry: LogEntry) => this.write(entry);
    }

    close(): void {
        this.stream.end();
    }
}
