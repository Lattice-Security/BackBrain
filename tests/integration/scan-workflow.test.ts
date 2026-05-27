import { describe, test, expect, beforeEach } from 'bun:test';
import { SecurityService, SemgrepScanner, VibeCodeScanner, applyFixes, runSecurityScan } from '@backbrain/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Scan Workflow Integration', () => {
    let tempDir: string;
    let testFile: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbrain-test-'));
        testFile = path.join(tempDir, 'test.js');
    });

    test('scan file → display issues → apply fix → verify', async () => {
        // Create vulnerable file
        fs.writeFileSync(testFile, `
const password = "hardcoded123";
fs.readFileSync(secretPath);
eval(userInput);
        `.trim());

        // Scan
        const scanners = [new SemgrepScanner(), new VibeCodeScanner()];
        const service = new SecurityService(scanners);
        const content = fs.readFileSync(testFile, 'utf-8');
        const result = await service.scanFile(testFile, content);

        const issues = result.issues;
        expect(issues.length).toBeGreaterThan(0);

        // Apply fix (if available)
        const fixableIssues = issues.filter(i => i.suggestedFix?.autoFixable);
        if (fixableIssues.length > 0) {
            const { summary } = await applyFixes(fixableIssues, { safeOnly: true });
            expect(summary.fixed).toBeGreaterThan(0);
        }
    }, 30000);

    test('filter by severity', async () => {
        fs.writeFileSync(testFile, `
componentWillMount();
fs.readFileSync(secretPath);
        `.trim());

        new SecurityService([new VibeCodeScanner()]);
        const result = await runSecurityScan([testFile], {
            scanners: ['vibe-code'],
            minSeverity: 'high',
        });

        const issues = result.issues;
        expect(issues.length).toBeGreaterThan(0);
        issues.forEach(issue => {
            expect(['critical', 'high']).toContain(issue.severity);
        });
    });
});
