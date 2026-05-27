import * as fs from 'fs/promises';
import * as path from 'path';
import type { FileSystem, FileInfo } from '../ports';

export class NodeFilesystem implements FileSystem {
    async readFile(filePath: string): Promise<string> {
        return fs.readFile(filePath, 'utf-8');
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        await fs.writeFile(filePath, content, 'utf-8');
    }

    async exists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async readDir(dirPath: string): Promise<FileInfo[]> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            path: path.join(dirPath, entry.name),
        }));
    }

    watch(_path: string, _callback: (event: 'change' | 'delete', path: string) => void): () => void {
        return () => {};
    }
}
