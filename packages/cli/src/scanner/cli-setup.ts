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
    scannerNames?: string[] | undefined;
    opencodeModel?: string | undefined;
    opencodeVariant?: string | undefined;
    agentBackends?: string[] | undefined;
    preferredBackend?: 'codex' | 'gemini' | 'opencode' | undefined;
    reviewScope?: 'workspace' | 'changed-files' | 'both' | undefined;
    maxSpecialists?: number | undefined;
    specialistConcurrency?: number | undefined;
    delayBetweenCallsMs?: number | undefined;
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
        const allBackendIds = ['codex', 'gemini', 'opencode'] as const;
        const enabledSet = options.agentBackends
            ? new Set(options.agentBackends)
            : null;

        const backendsConfig: Record<string, { enabled: boolean }> = {};
        for (const id of allBackendIds) {
            backendsConfig[id] = {
                enabled: enabledSet ? enabledSet.has(id) : true,
            };
        }

        scanners.push(new CliAgentReviewScanner({
            ...(options.maxSpecialists !== undefined ? { maxSpecialists: options.maxSpecialists } : {}),
            ...(options.specialistConcurrency !== undefined ? { specialistConcurrency: options.specialistConcurrency } : {}),
            ...(options.delayBetweenCallsMs !== undefined ? { delayBetweenCallsMs: options.delayBetweenCallsMs } : {}),
            ...(options.reviewScope !== undefined ? { reviewScope: options.reviewScope } : {}),
            ...(options.preferredBackend !== undefined ? { preferredBackend: options.preferredBackend } : {}),
            backends: {
                opencode: {
                    ...backendsConfig.opencode,
                    ...(options.opencodeModel ? { model: options.opencodeModel } : {}),
                    ...(options.opencodeVariant ? { variant: options.opencodeVariant } : {}),
                },
                codex: {
                    ...backendsConfig.codex,
                },
                gemini: {
                    ...backendsConfig.gemini,
                },
            },
        }));
    }

    return scanners;
}
