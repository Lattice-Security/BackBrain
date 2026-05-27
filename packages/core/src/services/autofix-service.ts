/**
 * Auto-Fix Service
 * 
 * Applies fixes to code issues automatically, with support for reverting.
 */

import type { FileSystem } from '../ports';
import type { CodeIssue, CodeFix, FixResult, FixSummary } from '../types';
import { getLogger } from '../utils/logger';
import { Ok, Err, toError, type Result } from '../utils/result';
import { providerRegistry } from './provider-registry';

export interface AutoFixOptions {
    /** Only apply fixes marked as safe to auto-fix */
    safeOnly?: boolean;
    /** Create backup before fixing */
    createBackup?: boolean;
    /** Dry run - don't actually modify files */
    dryRun?: boolean;
}

export interface FileChange {
    filePath: string;
    originalContent: string;
    newContent: string;
}

/**
 * Store for reverting changes
 */
class ChangeStore {
    private changes: Map<string, FileChange[]> = new Map();
    private sessionId = 0;

    startSession(): string {
        this.sessionId++;
        const id = `session-${this.sessionId}-${Date.now()}`;
        this.changes.set(id, []);
        return id;
    }

    recordChange(sessionId: string, change: FileChange): void {
        const session = this.changes.get(sessionId);
        if (session) {
            session.push(change);
        }
    }

    getChanges(sessionId: string): FileChange[] {
        return this.changes.get(sessionId) ?? [];
    }

    clearSession(sessionId: string): void {
        this.changes.delete(sessionId);
    }
}

const changeStore = new ChangeStore();

export function getSessionChanges(sessionId: string): FileChange[] {
    return changeStore.getChanges(sessionId);
}

export function loadSessionChanges(sessionId: string, changes: FileChange[]): void {
    changeStore.clearSession(sessionId);
    for (const change of changes) {
        changeStore.recordChange(sessionId, change);
    }
}

/**
 * Apply a single fix to file content
 */
function applyFix(content: string, issue: CodeIssue, fix: CodeFix): Result<string, string> {
    const lines = content.split('\n');
    const lineIndex = issue.location.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
        return Err(`Invalid line number: ${issue.location.line}`);
    }

    const line = lines[lineIndex];

    if (!line) {
        return Err(`Line ${issue.location.line} is empty`);
    }

    // Find and replace the original content
    if (fix.original && line.includes(fix.original)) {
        lines[lineIndex] = line.replace(fix.original, fix.replacement);
        return Ok(lines.join('\n'));
    }

    // If no original specified, replace the whole line
    if (!fix.original) {
        lines[lineIndex] = fix.replacement;
        return Ok(lines.join('\n'));
    }

    return Err(`Could not find original content to replace: "${fix.original}"`);
}

/**
 * Apply fixes to a single file
 */
async function applyFixesToFile(
    filePath: string,
    issues: CodeIssue[],
    fs: FileSystem,
    sessionId: string,
    options: AutoFixOptions
): Promise<FixResult[]> {
    const logger = getLogger();
    const results: FixResult[] = [];

    // Read current content
    let content: string;
    try {
        content = await fs.readFile(filePath);
    } catch (error) {
        logger.error(`Failed to read file: ${filePath}`, { error: toError(error) });
        return issues.map(issue => ({
            issue,
            applied: false,
            error: `Failed to read file: ${error}`,
        }));
    }

    const originalContent = content;
    let modified = false;

    // Sort issues by line number (descending) to apply fixes from bottom to top
    // This prevents line number shifts from affecting subsequent fixes
    const sortedIssues = [...issues].sort(
        (a, b) => b.location.line - a.location.line
    );

    for (const issue of sortedIssues) {
        if (!issue.suggestedFix) {
            results.push({
                issue,
                applied: false,
                error: 'No fix available',
            });
            continue;
        }

        const fix = issue.suggestedFix;

        if (options.safeOnly && !fix.autoFixable) {
            results.push({
                issue,
                applied: false,
                error: 'Fix not marked as safe for auto-fix',
            });
            continue;
        }

        const result = applyFix(content, issue, fix);

        if (result.ok) {
            content = result.value;
            modified = true;
            results.push({
                issue,
                applied: true,
                originalContent,
                newContent: content,
            });
            logger.debug(`Applied fix for ${issue.title}`, { filePath, line: issue.location.line });
        } else {
            results.push({
                issue,
                applied: false,
                error: result.error,
            });
            logger.warn(`Failed to apply fix: ${result.error}`, { issue: issue.title });
        }
    }

    // Write back if modified and not dry run
    if (modified && !options.dryRun) {
        try {
            // Record for potential revert
            changeStore.recordChange(sessionId, {
                filePath,
                originalContent,
                newContent: content,
            });

            await fs.writeFile(filePath, content);
            logger.info(`Updated file: ${filePath}`);
        } catch (error) {
            logger.error(`Failed to write file: ${filePath}`, { error: toError(error) });
            // Mark all fixes as failed
            return results.map(r => ({
                ...r,
                applied: false,
                error: `Failed to write file: ${error}`,
            }));
        }
    }

    return results;
}

/**
 * Apply fixes for multiple issues
 */
export async function applyFixes(
    issues: CodeIssue[],
    options: AutoFixOptions = {}
): Promise<{ summary: FixSummary; sessionId: string }> {
    const logger = getLogger();
    const fs = providerRegistry.getFilesystem();

    if (!fs) {
        throw new Error('No filesystem provider registered');
    }

    const sessionId = changeStore.startSession();
    logger.info(`Starting auto-fix session: ${sessionId}`, { issueCount: issues.length });

    // Group issues by file
    const issuesByFile = new Map<string, CodeIssue[]>();
    for (const issue of issues) {
        const filePath = issue.location.filePath;
        const existing = issuesByFile.get(filePath) ?? [];
        existing.push(issue);
        issuesByFile.set(filePath, existing);
    }

    // Apply fixes file by file
    const allResults: FixResult[] = [];

    for (const [filePath, fileIssues] of issuesByFile) {
        const results = await applyFixesToFile(filePath, fileIssues, fs, sessionId, options);
        allResults.push(...results);
    }

    // Create summary
    const summary: FixSummary = {
        totalIssues: issues.length,
        fixed: allResults.filter(r => r.applied).length,
        skipped: allResults.filter(r => !r.applied && !r.error).length,
        failed: allResults.filter(r => !r.applied && r.error).length,
        fixes: allResults,
    };

    logger.info(`Auto-fix session complete`, {
        sessionId,
        total: summary.totalIssues,
        fixed: summary.fixed,
        failed: summary.failed,
    });

    return { summary, sessionId };
}

/**
 * Revert changes from a fix session
 */
export async function revertFixes(sessionId: string): Promise<Result<number, string>> {
    const logger = getLogger();
    const fs = providerRegistry.getFilesystem();

    if (!fs) {
        return Err('No filesystem provider registered');
    }

    const changes = changeStore.getChanges(sessionId);

    if (changes.length === 0) {
        return Err(`No changes found for session: ${sessionId}`);
    }

    logger.info(`Reverting ${changes.length} file(s) from session ${sessionId}`);

    let reverted = 0;
    for (const change of changes) {
        try {
            await fs.writeFile(change.filePath, change.originalContent);
            reverted++;
            logger.debug(`Reverted: ${change.filePath}`);
        } catch (error) {
            logger.error(`Failed to revert: ${change.filePath}`, { error: toError(error) });
        }
    }

    changeStore.clearSession(sessionId);

    return Ok(reverted);
}

/**
 * Generate a user-friendly summary message
 */
export function formatSummary(summary: FixSummary): string {
    if (summary.fixed === 0 && summary.totalIssues === 0) {
        return '✓ No issues found';
    }

    if (summary.fixed === summary.totalIssues) {
        return `✓ ${summary.fixed} issue${summary.fixed === 1 ? '' : 's'} fixed`;
    }

    const parts: string[] = [];

    if (summary.fixed > 0) {
        parts.push(`${summary.fixed} fixed`);
    }

    if (summary.failed > 0) {
        parts.push(`${summary.failed} failed`);
    }

    if (summary.skipped > 0) {
        parts.push(`${summary.skipped} skipped`);
    }

    return parts.join(', ');
}
