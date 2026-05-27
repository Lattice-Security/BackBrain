import { ScanResultStore } from '@backbrain/core';

export interface StatusArgs {
    dir: string;
    verbose: boolean;
}

export async function statusCommand(args: StatusArgs): Promise<void> {
    const store = new ScanResultStore(args.dir);
    const record = await store.loadLast();

    if (!record) {
        console.log('No previous scan results found.');
        console.log('Run "backbrain scan" first.');
        return;
    }

    const date = new Date(record.timestamp);
    console.log('');
    console.log(`Last scan — ${date.toLocaleString()}`);
    console.log('\u2500'.repeat(50));
    console.log(`  Scan ID:     ${record.scanId}`);
    console.log(`  Duration:    ${(record.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Files:       ${record.filesScanned}`);
    console.log(`  Risk score:  ${record.summary.riskScore}/100`);
    console.log(`  Total:       ${record.summary.total} issue(s)`);
    console.log('');

    const sev = record.summary.bySeverity;
    if (sev.critical) console.log(`  critical: ${sev.critical}`);
    if (sev.high) console.log(`  high:      ${sev.high}`);
    if (sev.medium) console.log(`  medium:    ${sev.medium}`);
    if (sev.low) console.log(`  low:       ${sev.low}`);
    if (sev.info) console.log(`  info:      ${sev.info}`);
    console.log('');

    if (record.errors.length > 0) {
        console.log('Scanner errors:');
        for (const err of record.errors) {
            console.log(`  ${err.scanner}: ${err.message}`);
        }
        console.log('');
    }

    if (args.verbose && record.issues.length > 0) {
        console.log('Issues:');
        for (const issue of record.issues) {
            console.log(`  ${issue.severity.toUpperCase()}  ${issue.location.filePath}:${issue.location.line}`);
            console.log(`           ${issue.title}`);
            console.log('');
        }
    }
}
