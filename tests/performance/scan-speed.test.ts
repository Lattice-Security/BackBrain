import { describe, test, expect } from 'bun:test';
import { SecurityService, SemgrepScanner, VibeCodeScanner } from '@backbrain/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Performance Benchmarks', () => {
    test('vibe scanner completes in <100ms per file', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbrain-perf-'));
        const testFile = path.join(tempDir, 'test.js');
        fs.writeFileSync(testFile, 'const x = 1;\nconst y = 2;\n'.repeat(100));

        const scanner = new VibeCodeScanner();
        const start = performance.now();
        await scanner.scan([testFile]);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(100);
        fs.rmSync(tempDir, { recursive: true });
    });

    test('scan 10 files in <5 seconds', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbrain-perf-'));
        const files = Array(10).fill(null).map((_, i) => {
            const file = path.join(tempDir, `test${i}.js`);
            fs.writeFileSync(file, `const x${i} = ${i};\n`.repeat(50));
            return file;
        });

        const service = new SecurityService([new VibeCodeScanner()]);
        const start = performance.now();
        
        await Promise.all(files.map(async (filePath) => {
            const content = fs.readFileSync(filePath, 'utf-8');
            await service.scanFile(filePath, content);
        }));
        
        const duration = performance.now() - start;
        expect(duration).toBeLessThan(5000);
        
        fs.rmSync(tempDir, { recursive: true });
    });

    test('report generation completes in <1 second', () => {
        const { ReportService } = require('@backbrain/core');
        const issues = Array(100).fill(null).map((_, i) => ({
            id: `test-${i}`,
            title: `Issue ${i}`,
            description: 'Test',
            severity: 'medium',
            location: { filePath: '/test.js', line: i, column: 1 },
            type: 'security_vulnerability',
            category: 'logic',
        }));

        const service = new ReportService();
        const start = performance.now();
        service.generateJSON(issues);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(1000);
    });
});
