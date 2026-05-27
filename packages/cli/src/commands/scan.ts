import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    SecurityService,
    ScanResultStore,
    FileLogOutput,
    configureLogger,
    addLoggerOutput,
    getLogger,
    LOG_LEVELS,
    applyFixes,
    getSessionChanges,
    FixSessionStore,
    NodeFilesystem,
    providerRegistry,
    type SecurityScanStatusUpdate,
    type ScanRecord,
} from '@backbrain/core';
import { createScanners } from '../scanner/cli-setup';

const execFileAsync = promisify(execFile);

export interface ScanArgs {
    dir: string;
    json: boolean;
    minSeverity?: string | undefined;
    changed: boolean;
    verbose: boolean;
    noAgent: boolean;
    noSave: boolean;
    scanners?: string[] | undefined;
    fix: boolean;
    fixAll: boolean;
    commit: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([
    'node_modules', 'bower_components', 'jspm_packages', '.pnpm', '.yarn',
    '.git', '.svn', '.hg',
    'dist', 'build', 'out', 'coverage',
    '.venv', 'venv', 'env', '.tox', '__pypackages__', 'site-packages',
    '.gradle', '.m2', 'target',
    'Pods', 'Carthage', 'DerivedData',
    '.next', '.nuxt', '.output',
    'vendor',
]);

export async function scanCommand(args: ScanArgs): Promise<number> {
    const root = path.resolve(args.dir);

    if (args.verbose) {
        configureLogger(LOG_LEVELS.DEBUG);
    }

    const store = new ScanResultStore(root);
    const logFile = new FileLogOutput(path.join(store.basePath, 'scan-log.jsonl'));
    addLoggerOutput(logFile.handler);

    const logger = getLogger();
    logger.info('CLI scan started', { root, args });

    const scanners = createScanners({
        noAgent: args.noAgent,
        scannerNames: args.scanners,
    });

    const securityService = new SecurityService(scanners);

    const errors: { scanner: string; message: string }[] = [];

    const onStatus = (update: SecurityScanStatusUpdate): void => {
        if (update.phase === 'degraded' && update.scanner) {
            errors.push({ scanner: update.scanner, message: update.message });
            store.addError(update.scanner, update.message);
        }
        if (args.verbose && update.phase !== 'degraded') {
            logger.info(`[${update.phase}] ${update.message}`);
        }
    };

    const supportedExtensions = await securityService.getSupportedExtensions();
    logger.info(`Supported extensions: ${supportedExtensions.join(', ')}`);

    let files: string[];

    if (args.changed) {
        files = await getChangedFiles(root, supportedExtensions);
        logger.info(`Changed files: ${files.length}`);
    } else {
        files = await walkFiles(root, supportedExtensions);
        logger.info(`Source files found: ${files.length}`);
    }

    if (files.length === 0) {
        logger.info('No files to scan');
        console.log('No matching files found in workspace.');
        await store.save({
            issues: [],
            scannedFiles: [],
            scanDurationMs: 0,
            scannersUsed: [],
        });
        return 0;
    }

    logger.info(`Scanning ${files.length} file(s) with ${scanners.length} scanner(s)`);

    const result = await securityService.scan(files, {
        scanners: args.scanners,
        minSeverity: args.minSeverity,
        onStatus,
    } as any);

    logger.info('Scan completed', {
        issues: result.issues.length,
        files: result.scannedFiles.length,
        durationMs: result.scanDurationMs,
    });

    const record = await store.save(result);

    // ── Fix pipeline ─────────────────────────────────────────────────────
    if (args.fix && result.issues.length > 0) {
        const fixable = result.issues.filter(i => i.suggestedFix);
        const safe = fixable.filter(i => i.suggestedFix!.autoFixable);

        if (fixable.length === 0) {
            logger.info('No fixable issues found');
        } else {
            const target = args.fixAll ? fixable : safe;
            if (!args.fixAll && safe.length < fixable.length) {
                logger.info(`Skipping ${fixable.length - safe.length} non-auto-fixable issue(s) (use --fix-all to include)`);
            }

            const fs = new NodeFilesystem();
            providerRegistry.registerFilesystem('node-fs', fs, true);

            const fixResult = await applyFixes(target, { safeOnly: !args.fixAll });

            const fixStore = new FixSessionStore(root);
            const changes = getSessionChanges(fixResult.sessionId);
            await fixStore.save({
                sessionId: fixResult.sessionId,
                timestamp: new Date().toISOString(),
                scanId: record.scanId,
                summary: {
                    totalIssues: fixResult.summary.totalIssues,
                    fixed: fixResult.summary.fixed,
                    skipped: fixResult.summary.skipped,
                    failed: fixResult.summary.failed,
                },
                changes,
            });

            if (!args.json) {
                console.log('');
                console.log(`Fixed ${fixResult.summary.fixed} of ${fixResult.summary.totalIssues} issue(s) (session: ${fixResult.sessionId})`);
                if (fixResult.summary.failed > 0) {
                    console.log(`${fixResult.summary.failed} fix(es) failed`);
                }
            }

            // Re-scan if fixes were applied
            if (fixResult.summary.fixed > 0) {
                logger.info('Re-scanning after fixes...');
                const reResult = await securityService.scan(files, {
                    scanners: args.scanners,
                    minSeverity: args.minSeverity,
                    onStatus,
                } as any);

                const reRecord = await store.save(reResult);
                const remaining = reResult.issues.length;

                logger.info(`Re-scan: ${remaining} issue(s) remaining`);

                if (!args.json) {
                    console.log('');
                    console.log(`Re-scan: ${remaining} issue(s) remaining (was ${result.issues.length})`);
                    if (remaining > 0) {
                        printSummary(reRecord, []);
                    }
                }

                // ── Git commit ──────────────────────────────────────────
                if (args.commit && remaining === 0) {
                    logger.info('All issues resolved, committing...');
                    try {
                        const { execFile } = await import('child_process');
                        const { promisify } = await import('util');
                        const execAsync = promisify(execFile);

                        await execAsync('git', ['add', '-A'], { cwd: root, timeout: 15000 });
                        const msg = `chore: auto-fix security issues (session ${fixResult.sessionId})`;
                        await execAsync('git', ['commit', '-m', msg], { cwd: root, timeout: 15000 });
                        console.log(`Committed with message: ${msg}`);
                    } catch (commitErr) {
                        logger.warn('Git commit failed', { error: String(commitErr) });
                        console.warn('Git commit failed (may need manual commit)');
                    }
                } else if (args.commit && remaining > 0) {
                    console.log(`${remaining} issue(s) still present — skipping commit`);
                }
            }
        }
    }

    if (args.json) {
        console.log(JSON.stringify(record, null, 2));
    } else {
        printSummary(record, errors);
    }

    if (!args.noSave) {
        logger.info(`Results saved to ${store.basePath}`);
    }

    if (errors.length > 0) {
        logger.warn(`Scan completed with ${errors.length} error(s)`);
    }

    return result.issues.length > 0 ? 1 : 0;
}

function printSummary(
    record: ScanRecord,
    errors: { scanner: string; message: string }[],
): void {
    const date = new Date(record.timestamp);
    console.log('');
    console.log(`BackBrain Scan — ${date.toLocaleString()}`);
    console.log('\u2500'.repeat(50));
    console.log(`Files scanned: ${record.filesScanned}`);
    console.log(`Duration: ${(record.durationMs / 1000).toFixed(1)}s`);
    console.log(`Risk score: ${record.summary.riskScore}`);
    console.log('');

    const sev = record.summary.bySeverity;
    console.log(`Summary: ${record.summary.total} issue(s)`);
    if (sev.critical) console.log(`  critical: ${sev.critical}`);
    if (sev.high) console.log(`  high:      ${sev.high}`);
    if (sev.medium) console.log(`  medium:    ${sev.medium}`);
    if (sev.low) console.log(`  low:       ${sev.low}`);
    if (sev.info) console.log(`  info:      ${sev.info}`);
    console.log('');

    if (record.issues.length > 0) {
        const labelWidth = 8;
        console.log('Issues:');
        for (const issue of record.issues) {
            const label = issue.severity.toUpperCase().padEnd(labelWidth);
            const loc = `${issue.location.filePath}:${issue.location.line}`;
            console.log(`  ${label}  ${loc}`);
            console.log(`  ${''.padEnd(labelWidth)}  ${issue.title}`);
            console.log('');
        }
    }

    if (errors.length > 0) {
        console.log('Scanner errors:');
        for (const err of errors) {
            console.log(`  ${err.scanner}: ${err.message}`);
        }
        console.log('');
    }
}

async function walkFiles(
    root: string,
    extensions: string[],
): Promise<string[]> {
    const result: string[] = [];
    const extSet = new Set(extensions);

    async function walk(dir: string): Promise<void> {
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            return;
        }

        for (const name of names) {
            const fullPath = path.join(dir, name);

            let stat: fs.Stats;
            try {
                stat = await fs.promises.stat(fullPath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                if (!EXCLUDED_DIRECTORIES.has(name)) {
                    await walk(fullPath);
                }
            } else if (stat.isFile()) {
                if (extSet.has(path.extname(name))) {
                    result.push(fullPath);
                }
            }
        }
    }

    await walk(root);
    return result;
}

async function getChangedFiles(
    root: string,
    extensions: string[],
): Promise<string[]> {
    try {
        const extSet = new Set(extensions);
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
            cwd: root,
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });

        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((file) => {
                const ext = path.extname(file);
                return extSet.has(ext);
            })
            .map((file) => path.resolve(root, file));
    } catch {
        return [];
    }
}
