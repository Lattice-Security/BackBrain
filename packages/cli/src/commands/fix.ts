import * as path from 'path';
import {
    applyFixes,
    revertFixes,
    formatSummary,
    getSessionChanges,
    loadSessionChanges,
    ScanResultStore,
    FixSessionStore,
    NodeFilesystem,
    providerRegistry,
    getLogger,
    configureLogger,
    LOG_LEVELS,
    type FixSummary,
} from '@backbrain/core';

export interface FixArgs {
    dir: string;
    issueId?: string | undefined;
    all: boolean;
    dryRun: boolean;
    revert?: string | undefined;
    scanId?: string | undefined;
    json: boolean;
    verbose: boolean;
}

export async function fixCommand(args: FixArgs): Promise<number> {
    const root = path.resolve(args.dir);

    if (args.verbose) {
        configureLogger(LOG_LEVELS.DEBUG);
    }

    const logger = getLogger();

    if (args.revert) {
        return handleRevert(root, args.revert, logger);
    }

    const scanStore = new ScanResultStore(root);
    const record = args.scanId
        ? await scanStore.loadScan(args.scanId)
        : await scanStore.loadLast();

    if (!record) {
        logger.error('No scan result found');
        console.error('No scan result found. Run `backbrain scan` first.');
        return 1;
    }

    const issues = args.issueId
        ? record.issues.filter(i => i.id === args.issueId)
        : record.issues;

    if (issues.length === 0) {
        logger.info('No matching issues to fix');
        console.log('No matching issues found.');
        return 0;
    }

    const issuesWithFix = issues.filter(i => i.suggestedFix);
    const safeIssues = issuesWithFix.filter(i => i.suggestedFix!.autoFixable);

    if (issuesWithFix.length === 0) {
        logger.info('No fixable issues found in scan result');
        console.log('No issues with available fixes found in the scan result.');
        return 0;
    }

    if (!args.all && !args.issueId) {
        if (safeIssues.length === 0) {
            console.log('No safe auto-fixable issues found. Use --all to attempt all fixes.');
            return 0;
        }
        if (safeIssues.length < issuesWithFix.length) {
            const skipped = issuesWithFix.length - safeIssues.length;
            logger.info(`Skipping ${skipped} issue(s) not marked as safe (use --all to include)`);
        }
    }

    const targetIssues = args.all || args.issueId ? issuesWithFix : safeIssues;

    logger.info(`Applying ${targetIssues.length} fix(es)`, {
        total: issues.length,
        fixable: issuesWithFix.length,
        target: targetIssues.length,
        dryRun: args.dryRun,
    });

    const fs = new NodeFilesystem();
    providerRegistry.registerFilesystem('node-fs', fs, true);

    const result = await applyFixes(targetIssues, {
        safeOnly: !args.all && !args.issueId,
        dryRun: args.dryRun,
    });

    if (!args.dryRun) {
        const changes = getSessionChanges(result.sessionId);
        const fixStore = new FixSessionStore(root);
        await fixStore.save(Object.assign(
            {
                sessionId: result.sessionId,
                timestamp: new Date().toISOString(),
                summary: {
                    totalIssues: result.summary.totalIssues,
                    fixed: result.summary.fixed,
                    skipped: result.summary.skipped,
                    failed: result.summary.failed,
                },
                changes,
            },
            args.scanId ? { scanId: args.scanId } : {},
        ));
    }

    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printFixSummary(result.summary, args.dryRun);
    }

    return result.summary.failed > 0 ? 1 : 0;
}

async function handleRevert(
    root: string,
    sessionId: string,
    logger: ReturnType<typeof getLogger>,
): Promise<number> {
    const fixStore = new FixSessionStore(root);
    const session = await fixStore.load(sessionId);

    if (!session) {
        logger.error(`Fix session not found: ${sessionId}`);
        console.error(`Fix session not found: ${sessionId}`);
        return 1;
    }

    if (session.changes.length === 0) {
        console.log('No changes to revert in this session.');
        return 0;
    }

    const fs = new NodeFilesystem();
    providerRegistry.registerFilesystem('node-fs', fs, true);

    // Load changes into the session store so revertFixes can find them
    loadSessionChanges(sessionId, session.changes);

    const result = await revertFixes(sessionId);
    if (result.ok) {
        console.log(`Reverted ${result.value} file(s) from session ${sessionId}`);
        await fixStore.delete(sessionId);
        return 0;
    } else {
        console.error(`Revert failed: ${result.error}`);
        return 1;
    }
}

function printFixSummary(summary: FixSummary, dryRun: boolean): void {
    console.log('');
    console.log(dryRun ? 'DRY RUN — no files were modified' : 'Fix Results');
    console.log('\u2500'.repeat(50));
    console.log(`Total issues: ${summary.totalIssues}`);
    console.log(`Fixed:        ${summary.fixed}`);
    console.log(`Skipped:      ${summary.skipped}`);
    console.log(`Failed:       ${summary.failed}`);
    console.log('');

    if (summary.fixes.length > 0) {
        for (const fix of summary.fixes) {
            const loc = `${fix.issue.location.filePath}:${fix.issue.location.line}`;
            const status = fix.applied ? '✓' : fix.error ? '✗' : '–';
            console.log(`  ${status}  ${loc}`);
            console.log(`       ${fix.issue.title}`);
            if (fix.error) {
                console.log(`       ${fix.error}`);
            }
            console.log('');
        }
    }

    console.log(formatSummary(summary));
}
