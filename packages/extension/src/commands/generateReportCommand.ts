import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReportService, CodeIssue, ComplianceInfo } from '@backbrain/core';
import { SeverityPanelProvider } from '../views/severity-panel-provider';
import * as Handlebars from 'handlebars';

interface GenerateReportCommandOptions {
    format?: 'HTML Report' | 'PDF Report' | 'JSON Data';
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

        const format = options?.format ?? await vscode.window.showQuickPick(['HTML Report', 'PDF Report', 'JSON Data'], {
            placeHolder: 'Select report format'
        });

        if (!format) return;

        // Select save location
        const defaultName = `backbrain-report-${new Date().toISOString().split('T')[0]}`;
        const ext = format === 'JSON Data' ? 'json' : format === 'PDF Report' ? 'pdf' : 'html';
        const filters = format === 'JSON Data'
            ? { 'JSON': ['json'] }
            : format === 'PDF Report'
                ? { 'PDF': ['pdf'] }
                : { 'HTML': ['html'] };

        const uri = options?.targetUri ?? await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(vscode.workspace.rootPath || '', `${defaultName}.${ext}`)),
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
                    // Generate HTML (used for both HTML and PDF — PDF saves HTML content with @media print styles)
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

                    // Inject print/PDF-specific styles when saving as PDF
                    if (format === 'PDF Report') {
                        const printStyles = `
                        <style>
                            @page { margin: 20mm 15mm; size: A4; }
                            @media print {
                                body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #000; background: #fff; }
                                .report-header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
                                .severity-critical, .severity-high, .severity-medium, .severity-low, .severity-info {
                                    display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10pt; font-weight: bold; color: #fff;
                                }
                                .severity-critical { background: #c00; }
                                .severity-high { background: #e67e22; }
                                .severity-medium { background: #f1c40f; color: #333; }
                                .severity-low { background: #3498db; }
                                .severity-info { background: #95a5a6; }
                                table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                                th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
                                th { background: #f5f5f5; font-weight: bold; }
                                .risk-score { font-size: 24pt; font-weight: bold; text-align: center; margin: 10px 0; }
                                .footer { text-align: center; font-size: 9pt; color: #888; margin-top: 30px; border-top: 1px solid #ccc; padding-top: 10px; }
                                .no-break { page-break-inside: avoid; }
                                @media screen { body { padding: 20px; max-width: 900px; margin: 0 auto; } }
                            }
                        </style>`;
                        templateSource = templateSource.replace('</head>', `${printStyles}\n</head>`);
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
                    if (format === 'HTML Report' || format === 'PDF Report') {
                        // Open in browser (PDF opens in browser's PDF viewer, HTML opens rendered)
                        vscode.env.openExternal(uri);
                    } else {
                        // Open JSON in VS Code
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
