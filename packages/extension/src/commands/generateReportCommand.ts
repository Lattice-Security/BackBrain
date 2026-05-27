import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReportService, CodeIssue, ComplianceInfo } from '@backbrain/core';
import { SeverityPanelProvider } from '../views/severity-panel-provider';
import * as Handlebars from 'handlebars';

interface GenerateReportCommandOptions {
    format?: 'HTML Report' | 'JSON Data';
    targetUri?: vscode.Uri;
    openAfterSave?: boolean;
}

export function registerGenerateReportCommand(
    context: vscode.ExtensionContext,
    panelProvider: SeverityPanelProvider
): vscode.Disposable {
    return vscode.commands.registerCommand('backbrain.generateReport', async (options?: GenerateReportCommandOptions) => {
        const issues = panelProvider.getIssues();

        if (issues.length === 0) {
            vscode.window.showWarningMessage('No issues to report. Please scan your workspace first.');
            return;
        }

        const format = options?.format ?? await vscode.window.showQuickPick(['HTML Report', 'JSON Data'], {
            placeHolder: 'Select report format'
        });

        if (!format) return;

        // Select save location
        const defaultName = `backbrain-report-${new Date().toISOString().split('T')[0]}`;
        const filters = format === 'HTML Report'
            ? { 'HTML': ['html'] }
            : { 'JSON': ['json'] };

        const uri = options?.targetUri ?? await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(vscode.workspace.rootPath || '', `${defaultName}.${format === 'HTML Report' ? 'html' : 'json'}`)),
            filters
        });

        if (!uri) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Report...',
            cancellable: false
        }, async () => {
            try {
                const reportService = new ReportService();
                // Convert IssueData back to CodeIssue (they are compatible mostly)
                const codeIssues = issues as unknown as CodeIssue[];

                // Load custom compliance map if exists
                let customComplianceMap: Record<string, ComplianceInfo> | undefined;
                if (vscode.workspace.rootPath) {
                    const configPath = path.join(vscode.workspace.rootPath, '.backbrain', 'compliance.json');
                    if (fs.existsSync(configPath)) {
                        try {
                            const configContent = fs.readFileSync(configPath, 'utf-8');
                            customComplianceMap = JSON.parse(configContent);
                        } catch (e) {
                            console.error('Failed to load compliance.json', e);
                            vscode.window.showWarningMessage('Failed to load .backbrain/compliance.json');
                        }
                    }
                }

                let content = '';

                if (format === 'JSON Data') {
                    content = reportService.generateJSON(codeIssues, customComplianceMap);
                } else {
                    // Generate HTML
                    const data = reportService.generateReportData(codeIssues, customComplianceMap);
                    const templatePath = path.join(context.extensionPath, 'src', 'templates', 'report-template.html');

                    // Read template
                    let templateSource = '';
                    try {
                        templateSource = fs.readFileSync(templatePath, 'utf-8');
                    } catch (e) {
                        // Fallback for dev environment if src not available in build
                        const distPath = path.join(context.extensionPath, 'dist', 'templates', 'report-template.html');
                        templateSource = fs.readFileSync(distPath, 'utf-8');
                    }

                    // Compile with Handlebars
                    const template = Handlebars.compile(templateSource);
                    content = template(data);
                }

                fs.writeFileSync(uri.fsPath, content);

                if (options?.openAfterSave === false) {
                    return;
                }

                const selection = await vscode.window.showInformationMessage(
                    `Report saved to ${path.basename(uri.fsPath)}`,
                    'Open Report'
                );

                if (selection === 'Open Report') {
                    if (format === 'HTML Report') {
                        // Open in browser
                        vscode.env.openExternal(uri);
                    } else {
                        // Open in VS Code
                        vscode.workspace.openTextDocument(uri).then(doc => {
                            vscode.window.showTextDocument(doc);
                        });
                    }
                }

            } catch (error) {
                vscode.window.showErrorMessage(`Failed to generate report: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });
}
