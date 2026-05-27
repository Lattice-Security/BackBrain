import type { SecurityScanner } from '@backbrain/core';
import {
    VibeCodeScanner,
    SemgrepScanner,
    GitleaksScanner,
    TrivyScanner,
    OSVScanner,
    CliAgentReviewScanner,
} from '@backbrain/core';

export interface SetupOptions {
    noAgent?: boolean;
    scannerNames?: string[];
}

export function createScanners(options: SetupOptions = {}): SecurityScanner[] {
    const scanners: SecurityScanner[] = [
        new VibeCodeScanner(),
    ];

    if (!options.scannerNames || options.scannerNames.includes('semgrep')) {
        scanners.push(new SemgrepScanner());
    }
    if (!options.scannerNames || options.scannerNames.includes('gitleaks')) {
        scanners.push(new GitleaksScanner());
    }
    if (!options.scannerNames || options.scannerNames.includes('trivy')) {
        scanners.push(new TrivyScanner());
    }
    if (!options.scannerNames || options.scannerNames.includes('osv-scanner')) {
        scanners.push(new OSVScanner());
    }

    if (!options.noAgent) {
        scanners.push(new CliAgentReviewScanner());
    }

    return scanners;
}
