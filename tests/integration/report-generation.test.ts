import { describe, test, expect } from 'bun:test';
import { ReportService, type CodeIssue } from '@backbrain/core';

describe('Report Generation Integration', () => {
    test('generate report with compliance mapping', () => {
        const issues: CodeIssue[] = [
            {
                id: 'test-1',
                title: 'SQL Injection',
                description: 'Unsafe SQL query',
                severity: 'critical',
                location: { filePath: '/test.js', line: 10, column: 5 },
                type: 'security_vulnerability',
                category: 'injection',
            },
            {
                id: 'test-2',
                title: 'XSS Vulnerability',
                description: 'Unescaped output',
                severity: 'high',
                location: { filePath: '/test.js', line: 20, column: 3 },
                type: 'security_vulnerability',
                category: 'xss',
            },
        ];

        const service = new ReportService();
        const report = service.generateReportData(issues);

        expect(report.totalIssues).toBe(2);
        expect(report.severityCounts.critical).toBe(1);
        expect(report.severityCounts.high).toBe(1);
        expect(report.riskScore).toBeGreaterThan(0);
        expect(report.issues.length).toBe(2);
    });

    test('calculate risk score correctly', () => {
        const service = new ReportService();
        
        expect(service.calculateRiskScore({ critical: 5, high: 0, medium: 0, low: 0 })).toBe(100);
        expect(service.calculateRiskScore({ critical: 0, high: 0, medium: 0, low: 0 })).toBe(0);
        expect(service.calculateRiskScore({ critical: 1, high: 2, medium: 3, low: 4 })).toBe(60);
    });

    test('generate JSON report', () => {
        const issues: CodeIssue[] = [{
            id: 'test-1',
            title: 'Test Issue',
            description: 'Test',
            severity: 'medium',
            location: { filePath: '/test.js', line: 1, column: 1 },
            type: 'security_vulnerability',
            category: 'logic',
        }];

        const service = new ReportService();
        const json = service.generateJSON(issues);
        const parsed = JSON.parse(json);

        expect(parsed.totalIssues).toBe(1);
        expect(parsed.timestamp).toBeDefined();
    });
});
