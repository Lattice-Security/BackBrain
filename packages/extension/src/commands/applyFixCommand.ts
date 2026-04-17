/**
 * Apply Fix Command
 * 
 * Applies AI-suggested or rule-based fixes to code.
 * Integrates with AutoFixService and tracks sessions for revert.
 */

import * as vscode from 'vscode';
import {
    applyFixes,
    createLogger,
    formatSummary,
    type CodeIssue,
    type CodeFix,
} from '@backbrain/core';
import { getFixHistoryService } from '../services/fix-history-service';
import { clearFixPreview } from './suggestFixCommand';

const logger = createLogger('ApplyFixCommand');

function toCodeIssue(
    issue: { ruleId: string; title: string; description: string; severity: string; filePath: string; line: number; column?: number; snippet?: string },
    fix: { description: string; replacement: string; original?: string; autoFixable: boolean }
): CodeIssue {
    const codeFix: CodeFix = {
        description: fix.description,
        replacement: fix.replacement,
        original: fix.original ?? issue.snippet,
        autoFixable: fix.autoFixable,
    };

    return {
        id: `${issue.ruleId}-${issue.filePath}-${issue.line}`,
        ruleId: issue.ruleId,
        title: issue.title,
        description: issue.description,
        severity: issue.severity as 'critical' | 'high' | 'medium' | 'low' | 'info',
        location: {
            filePath: issue.filePath,
            line: issue.line,
            column: issue.column || 1,
        },
        suggestedFix: codeFix,
        type: 'security_vulnerability',
        category: 'security',
    };
}

/**
 * Register the applyFix command
 */
export function registerApplyFixCommand(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand(
        'backbrain.applyFix',
        async (issueData?: unknown, fixData?: unknown) => {
            // Validate inputs
            if (!issueData || typeof issueData !== 'object' || !fixData || typeof fixData !== 'object') {
                vscode.window.showWarningMessage('Invalid fix data provided.');
                return;
            }

            const issue = issueData as { ruleId: string; title: string; description: string; severity: string; filePath: string; line: number; column?: number; snippet?: string };
            const fix = fixData as { description: string; replacement: string; original?: string; autoFixable: boolean };

            // Ensure required fields exist
            if (!issue.ruleId || !issue.filePath || !issue.line || !fix.replacement) {
                vscode.window.showWarningMessage('Incomplete fix data.');
                return;
            }

            logger.info('Applying fix', { ruleId: issue.ruleId, file: issue.filePath });

            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'BackBrain',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Applying fix...' });

                    try {
                        const targetUri = vscode.Uri.file(issue.filePath);
                        const codeIssue = toCodeIssue(issue, fix);
                        const { summary, sessionId } = await applyFixes([codeIssue], {
                            safeOnly: false,
                            dryRun: false,
                        });

                        if (summary.fixed > 0) {
                            await clearFixPreview(issue.filePath);

                            const document = await vscode.workspace.openTextDocument(targetUri);
                            await vscode.window.showTextDocument(document, {
                                preview: false,
                                preserveFocus: false,
                            });

                            const historyService = getFixHistoryService();
                            await historyService.recordSession(sessionId, summary, [issue.filePath]);
                        } else if (summary.failed > 0) {
                            const error = summary.fixes[0]?.error || 'Unknown error';
                            vscode.window.showErrorMessage(`Fix failed: ${error}`);
                        }

                        logger.info('Fix applied', { sessionId, summary: formatSummary(summary) });
                        return { summary, sessionId };
                    } catch (error) {
                        logger.error('Failed to apply fix', { error });
                        vscode.window.showErrorMessage(
                            `Failed to apply fix: ${error instanceof Error ? error.message : 'Unknown error'}`
                        );
                        return undefined;
                    }
                }
            );

            if (!result || result.summary.fixed <= 0) {
                return;
            }

            const nextAction = await vscode.window.showInformationMessage(
                `✓ ${formatSummary(result.summary)}`,
                'Revert',
                'View File'
            );

            if (nextAction === 'Revert') {
                await vscode.commands.executeCommand('backbrain.revertFix', result.sessionId);
            } else if (nextAction === 'View File') {
                const doc = await vscode.workspace.openTextDocument(issue.filePath);
                await vscode.window.showTextDocument(doc);
            }
        }
    );
}

/**
 * Apply fix with preview confirmation
 */
export async function applyFixWithPreview(
    issue: { ruleId: string; title: string; description: string; severity: string; filePath: string; line: number; snippet?: string },
    fix: { description: string; replacement: string; original?: string; autoFixable: boolean }
): Promise<boolean> {
    // Show confirmation dialog
    const choice = await vscode.window.showInformationMessage(
        `Apply fix: ${fix.description}?`,
        { modal: true },
        'Apply',
        'Cancel'
    );

    if (choice !== 'Apply') {
        return false;
    }

    await vscode.commands.executeCommand('backbrain.applyFix', issue, fix);
    return true;
}
