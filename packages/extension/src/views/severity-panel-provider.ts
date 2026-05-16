import * as vscode from 'vscode';
import { createLogger, type SecurityScanStatusUpdate, type SecurityService } from '@backbrain/core';
import { type WebviewMessage, type IssueData, type FixData, toIssueData } from '../webview/messages';
import { getActiveProvider } from '../services/ai-adapter-factory';

const logger = createLogger('SeverityPanel');

export class SeverityPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'backbrain.severityPanel';
    private _view?: vscode.WebviewView;
    private _issues: IssueData[] = [];
    private _statusMessage: { level: 'info' | 'warn' | 'error'; message: string } | null = null;
    private _scanStatus: SecurityScanStatusUpdate | null = null;
    private _isScanning = false;
    private _lastScanError: string | null = null;
    private _lastBatchProgress: { current: number; total: number } | null = null;
    private _scanCancelTokenSource?: vscode.CancellationTokenSource;
    private _scanDepthTierLabel: string = 'Developer Scan';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _securityService: SecurityService,
    ) { }

    /**
     * Public method to show issues from an external scan
     */
    public showIssues(issues: any[]): void {
        const issueData: IssueData[] = issues.map(issue => toIssueData(issue));
        this._issues = issueData;
        this._lastScanError = null;
        this._lastBatchProgress = null;
        this._postMessage({ type: 'scanComplete', issues: issueData });

        // Focus the view if it exists
        if (this._view) {
            this._view.show(true);
        }
    }

    public updateFileIssues(_filePath: string, issues: any[]): void {
        const issueData: IssueData[] = issues.map(issue => toIssueData(issue));
        this._issues = issueData;
        this._lastScanError = null;
        this._lastBatchProgress = null;
        this._postMessage({ type: 'scanComplete', issues: this._issues });
    }

    public getIssues(): IssueData[] {
        return this._issues || [];
    }

    public setStatus(level: 'info' | 'warn' | 'error', message: string): void {
        this._statusMessage = { level, message };
        this._postMessage({ type: 'statusUpdate', level, message });
    }

    public clearStatus(): void {
        this._statusMessage = null;
        this._postMessage({ type: 'statusClear' });
    }

    public setScanDepthTier(label: string): void {
        this._scanDepthTierLabel = label;
        this._postMessage({ type: 'setScanDepthTier', label });
    }

    public updateScanStatus(update: SecurityScanStatusUpdate): void {
        this._scanStatus = update;
        this._postMessage({ type: 'scanStatus', ...update });
    }

    public async startWorkspaceScan(): Promise<void> {
        await this._handleScanRequest();
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,

            // Restrict the webview to only load resources from the extension directory
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        try {
            webviewView.webview.html = await this._getHtmlForWebview(webviewView.webview);
        } catch (error) {
            logger.error('Failed to load webview HTML', { error });
            webviewView.webview.html = `<!DOCTYPE html><html><body>
                <h3>Error loading BackBrain UI</h3>
                <p>Please ensure the extension is built correctly.</p>
                <pre>${error}</pre>
            </body></html>`;
        }

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
            switch (message.type) {
                case 'ready':
                    logger.debug('Webview is ready');
                    this._syncStateToWebview();
                    break;

                case 'requestScan':
                    await this._handleScanRequest();
                    break;

                case 'requestScanFile':
                    await this._handleScanFileRequest();
                    break;

                case 'navigateToIssue':
                    await this._handleNavigateToIssue(message.filePath, message.line, message.column);
                    break;

                case 'explainIssue':
                    await this._handleExplainIssue(message.issue);
                    break;

                case 'suggestFix':
                    await this._handleSuggestFix(message.issue);
                    break;

                // Phase 10: Fix message handlers
                case 'applyFix':
                    await this._handleApplyFix(message.issue, message.fix);
                    break;

                case 'revertFix':
                    await this._handleRevertFix(message.sessionId);
                    break;

                case 'batchFix':
                    await vscode.commands.executeCommand('backbrain.batchFix');
                    break;

                case 'exportReport':
                    await vscode.commands.executeCommand('backbrain.generateReport');
                    break;
            }
        });
    }

    /**
     * Handle scan request from webview
     */
    private async _handleScanRequest(): Promise<void> {
        if (this._isScanning) {
            // Cancel current scan if it's already running? 
            // For now, just prevent multiple workspace scans.
            logger.warn('Scan already in progress, skipping request');
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this._postMessage({ type: 'scanError', error: 'No workspace folder open' });
            return;
        }

        this._isScanning = true;
        this._lastScanError = null;
        this._lastBatchProgress = null;
        this._scanStatus = null;
        this._scanCancelTokenSource = new vscode.CancellationTokenSource();
        const token = this._scanCancelTokenSource.token;

        // Notify webview that scan is starting
        this._postMessage({ type: 'scanStarted' });
        logger.info('Starting workspace scan...');

        try {
            // 1. Find all files
            const extensions = await this._securityService.getSupportedExtensions();
            const extensionPattern = extensions.map(ext => ext.replace('.', '')).join(',');
            const globPattern = `**/*.{${extensionPattern}}`;

            const config = vscode.workspace.getConfiguration('backbrain');
            const defaultExcludes = ['node_modules', 'dist', 'build', '.git', 'out', '.vscode'];
            const userExcludes = config.get<string[]>('excludePaths', []);
            const excludePaths = Array.from(new Set([...defaultExcludes, ...userExcludes]));

            // Construct a glob pattern for exclusions
            const excludeGlob = `**/{${excludePaths.join(',')}}/**`;
            logger.debug(`Using exclude pattern: ${excludeGlob}`);

            const files = await vscode.workspace.findFiles(
                globPattern,
                excludeGlob,
                5000
            );

            // 2. Prioritize Strict Order: Active File -> Other Open Files -> Rest of Workspace
            const activeEditor = vscode.window.activeTextEditor;
            const activePath = (
                activeEditor &&
                !activeEditor.document.isUntitled &&
                activeEditor.document.uri.scheme === 'file'
            ) ? activeEditor.document.uri.fsPath : null;

            const openDocuments = vscode.workspace.textDocuments
                .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file' && doc.uri.fsPath !== activePath)
                .map(doc => doc.uri.fsPath);

            // Use a Set to track what's already in the queue to avoid duplicates
            const queuedPaths = new Set<string>();
            const scanQueue: string[] = [];

            // Phase 1: Active File
            if (activePath) {
                scanQueue.push(activePath);
                queuedPaths.add(activePath);
            }

            // Phase 2: Other Open Files
            openDocuments.forEach(path => {
                if (!queuedPaths.has(path)) {
                    scanQueue.push(path);
                    queuedPaths.add(path);
                }
            });

            // Phase 3: Rest of Workspace
            const allFilePaths = files.map(f => f.fsPath);
            allFilePaths.forEach(path => {
                if (!queuedPaths.has(path)) {
                    scanQueue.push(path);
                    queuedPaths.add(path);
                }
            });

            const totalFiles = scanQueue.length;
            let scannedCount = 0;
            const batchSize = 50;
            const startTime = Date.now();

            this._issues = []; // Reset local issue cache for new workspace scan

            logger.info(`Starting prioritized scan: ${scanQueue.length} files (Active: ${activePath ? 1 : 0}, Open: ${openDocuments.length}, Workspace: ${allFilePaths.length - queuedPaths.size + (activePath ? 1 : 0) + openDocuments.length})`);


            // 3. Process in batches
            for (let i = 0; i < totalFiles; i += batchSize) {
                if (token.isCancellationRequested) break;

                const batch = scanQueue.slice(i, i + batchSize);
                const batchStartTime = Date.now();

                const results = await this._securityService.scan(batch, {
                    onStatus: (update) => this.updateScanStatus(update),
                });

                const newIssues = results.issues.map(toIssueData);
                this._issues.push(...newIssues);

                scannedCount += batch.length;
                const batchDuration = Date.now() - batchStartTime;

                logger.debug(`Batch ${Math.floor(i / batchSize) + 1} complete: ${batch.length} files in ${batchDuration}ms`);

                // Update UI incrementally
                this._postMessage({
                    type: 'issuesUpdated',
                    issues: newIssues,
                    batchInfo: { current: scannedCount, total: totalFiles }
                });
                this._lastBatchProgress = { current: scannedCount, total: totalFiles };

                // Yield to keep event loop responsive
                await new Promise(resolve => setTimeout(resolve, 5));
            }

            const totalDuration = Date.now() - startTime;
            logger.info(`Workspace scan complete: ${this._issues.length} issues found in ${totalDuration}ms`);
            this.setStatus('info', `Workspace scan complete: ${this._issues.length} issue(s) found in ${Math.round(totalDuration / 100) / 10}s.`);
            this._postMessage({ type: 'scanComplete', issues: this._issues });

        } catch (error) {
            logger.error('Scan failed', { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._lastScanError = errorMessage;
            this._postMessage({ type: 'scanError', error: errorMessage });
        } finally {
            this._isScanning = false;
            this._scanCancelTokenSource?.dispose();

        }
    }

    /**
     * Handle scan file request from webview
     */
    private async _handleScanFileRequest(): Promise<void> {
        // Just trigger the command, it handles finding the active editor
        await vscode.commands.executeCommand('backbrain.scanFile');
    }

    /**
     * Navigate to issue location in editor
     */
    private async _handleNavigateToIssue(filePath: string, line: number, column?: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, { preserveFocus: true });

            // Create position (VS Code is 0-indexed, our data is 1-indexed)
            const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column || 1) - 1));

            // Move cursor and reveal
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );

            logger.debug('Navigated to issue', { filePath, line, column });
        } catch (error) {
            logger.error('Failed to navigate to issue', { error, filePath, line });
            vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
        }
    }

    /**
     * Handle explain issue request from webview
     */
    private async _handleExplainIssue(issueData: IssueData): Promise<void> {
        logger.info('Explaining issue', { id: issueData.id, title: issueData.title });

        // Convert IssueData to SecurityIssue format
        const issue = {
            ruleId: issueData.id,
            title: issueData.title,
            description: issueData.description,
            severity: issueData.severity,
            filePath: issueData.filePath,
            line: issueData.line,
            snippet: issueData.snippet,
        };

        // Invoke the AI explain command
        this._postMessage({
            type: 'explanationStarted',
            issueId: issueData.id,
            provider: getActiveProvider(),
        });

        await vscode.commands.executeCommand('backbrain.explainIssue', issue, {
            renderInPanel: true,
            useStreaming: true,
            onStart: ({ provider }: { provider: string | null }) => {
                this._postMessage({
                    type: 'explanationStarted',
                    issueId: issueData.id,
                    provider,
                });
            },
            onChunk: (chunk: string) => {
                this._postMessage({
                    type: 'explanationChunk',
                    issueId: issueData.id,
                    chunk,
                });
            },
            onComplete: (content: string, { provider }: { provider: string | null }) => {
                this._postMessage({
                    type: 'explanationComplete',
                    issueId: issueData.id,
                    content,
                    provider,
                });
            },
            onError: (error: string, { provider }: { provider: string | null }) => {
                this._postMessage({
                    type: 'explanationError',
                    issueId: issueData.id,
                    error,
                    provider,
                });
            },
        });
    }

    /**
     * Handle suggest fix request from webview
     */
    private async _handleSuggestFix(issueData: IssueData): Promise<void> {
        logger.info('Suggesting fix', { id: issueData.id, title: issueData.title });

        // Convert IssueData to SecurityIssue format
        const issue = {
            ruleId: issueData.id,
            title: issueData.title,
            description: issueData.description,
            severity: issueData.severity,
            filePath: issueData.filePath,
            line: issueData.line,
            snippet: issueData.snippet,
        };

        // Invoke the AI suggest fix command
        const fix = await vscode.commands.executeCommand<any>('backbrain.suggestFix', issue, { silent: false });

        if (fix) {
            this._postMessage({
                type: 'fixSuggested',
                issueId: issueData.id,
                fix: {
                    description: fix.description,
                    replacement: fix.replacement,
                    original: fix.original,
                    autoFixable: fix.autoFixable
                }
            });
        }
    }

    /**
     * Handle apply fix request from webview (Phase 10)
     */
    private async _handleApplyFix(issueData: IssueData, fix: FixData): Promise<void> {
        logger.info('Applying fix', { id: issueData.id, description: fix.description });

        const issue = {
            ruleId: issueData.id,
            title: issueData.title,
            description: issueData.description,
            severity: issueData.severity,
            filePath: issueData.filePath,
            line: issueData.line,
            snippet: issueData.snippet,
        };

        // Invoke the apply fix command
        await vscode.commands.executeCommand('backbrain.applyFix', issue, fix);
    }

    /**
     * Handle revert fix request from webview (Phase 10)
     */
    private async _handleRevertFix(sessionId: string): Promise<void> {
        logger.info('Reverting fix session', { sessionId });
        await vscode.commands.executeCommand('backbrain.revertFix', sessionId);
    }

    /**
     * Post message to webview
     */
    private _postMessage(message: { type: string;[key: string]: unknown }): void {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private _syncStateToWebview(): void {
        this._postMessage({ type: 'setScanDepthTier', label: this._scanDepthTierLabel });
        if (this._statusMessage) {
            this._postMessage({ type: 'statusUpdate', ...this._statusMessage });
        }
        if (this._scanStatus) {
            this._postMessage({ type: 'scanStatus', ...this._scanStatus });
        }
        if (this._isScanning) {
            this._postMessage({ type: 'scanStarted' });
        }
        if (this._issues.length > 0) {
            if (this._lastBatchProgress) {
                this._postMessage({
                    type: 'issuesUpdated',
                    issues: this._issues,
                    batchInfo: this._lastBatchProgress,
                });
            } else {
                this._postMessage({ type: 'scanComplete', issues: this._issues });
            }
        } else if (!this._isScanning && !this._lastScanError) {
            this._postMessage({ type: 'scanComplete', issues: [] });
        }
        if (this._lastScanError) {
            this._postMessage({ type: 'scanError', error: this._lastScanError });
        }
    }

    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlUri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.html');
        const htmlContent = await vscode.workspace.fs.readFile(htmlUri);
        let html = new TextDecoder().decode(htmlContent);

        const nonce = getNonce();

        // 1. Replace asset paths with webview URIs
        // Vite builds assets into /assets/ and references them with absolute paths in the built index.html
        html = html.replace(
            /(href|src)=(['"])\/assets\/([^'"]+)\2/gi,
            (_match, attr, _quote, fileName) => {
                const uri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets', fileName));
                return `${attr}="${uri}"`;
            }
        );

        // 2. Inject Content Security Policy (CSP) and Nonce
        // We use a more robust approach: find the <head> tag and inject CSP, then add nonce to all scripts.
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} https: data:`,
            `script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval' 'unsafe-inline'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `connect-src ${webview.cspSource} https:`,
            "worker-src 'self' blob:",
            "child-src 'self' blob:",
            "media-src 'none'",
            "object-src 'none'",
            "frame-src 'none'"
        ].join('; ');

        // 3. Disable Service Workers to prevent "InvalidStateError"
        // We inject this at the ABSOLUTE TOP of the head to ensure it runs before ANY other script or preload.
        const disableSwScript = `
        <script nonce="${nonce}">
            (function() {
                // Completely disable Service Workers in the webview context
                // This prevents "InvalidStateError: The document is in an invalid state"
                try {
                    const noop = () => {};
                    const reject = () => Promise.reject(new Error('ServiceWorkers disabled in Webview'));
                    
                    const swShim = {
                        register: reject,
                        getRegistration: () => Promise.resolve(undefined),
                        getRegistrations: () => Promise.resolve([]),
                        addEventListener: noop,
                        removeEventListener: noop,
                        dispatchEvent: () => true,
                        oncontrollerchange: null,
                        onmessage: null,
                        onmessageerror: null,
                        controller: null,
                        ready: new Promise(noop) // Never resolves
                    };

                    // Try to override both the instance and the prototype
                    Object.defineProperty(navigator, 'serviceWorker', {
                        value: swShim,
                        configurable: false,
                        writable: false,
                        enumerable: true
                    });

                    // Extra layer: proxy the global to catch any weird access patterns
                    console.log('BackBrain: ServiceWorker registration disabled');
                } catch (e) {
                    console.warn('BackBrain: Failed to shim navigator.serviceWorker:', e);
                }
            })();
        </script>`;

        const headContent = `\n\t\t<meta http-equiv="Content-Security-Policy" content="${csp}">\n\t\t${disableSwScript}`;

        if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/(<head[^>]*>)/i, `$1${headContent}`);
        } else {
            // Fallback: inject at the very beginning if <head> is missing
            html = `<head>${headContent}</head>\n${html}`;
        }

        // Add nonce to all script tags (module and regular)
        html = html.replace(/<script\b([^>]*)>/gi, (_match, attrs) => {
            if (attrs.includes('nonce=')) return _match;
            return `<script nonce="${nonce}" ${attrs}>`;
        });

        return html;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
