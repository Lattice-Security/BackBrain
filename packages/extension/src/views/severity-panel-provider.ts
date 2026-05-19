import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, type SecurityScanStatusUpdate, type SecurityService } from '@backbrain/core';
import {
    type AgentBackendId,
    type AgentScanDepth,
    type ConfigurationState,
    type ScanTarget,
    type WebviewMessage,
    type IssueData,
    type FixData,
    toIssueData,
} from '../webview/messages';
import { getActiveProvider } from '../services/ai-adapter-factory';
import { GeminiCliInstaller } from '../utils/gemini-cli-installer';

const logger = createLogger('SeverityPanel');
const execFileAsync = promisify(execFile);

const SCANNER_METADATA: Record<string, { label: string; description: string }> = {
    semgrep: { label: 'Semgrep', description: 'Static code analysis' },
    gitleaks: { label: 'Gitleaks', description: 'Secret detection' },
    trivy: { label: 'Trivy', description: 'Dependencies and IaC' },
    'osv-scanner': { label: 'OSV', description: 'Open source vulnerabilities' },
    'vibe-code': { label: 'Vibe Code', description: 'Project rules' },
    'tree-sitter': { label: 'Tree-sitter', description: 'AST heuristics' },
};

const DEFAULT_ENABLED_SCANNERS = Object.keys(SCANNER_METADATA);

const AGENT_BACKENDS: Record<AgentBackendId, { label: string; description: string; binarySetting: string; defaultBinary: string }> = {
    codex: {
        label: 'Codex',
        description: 'OpenAI Codex CLI',
        binarySetting: 'ai.agentBinaryPathCodex',
        defaultBinary: 'codex',
    },
    gemini: {
        label: 'Gemini',
        description: 'Google Gemini CLI',
        binarySetting: 'ai.agentBinaryPathGemini',
        defaultBinary: 'gemini',
    },
    opencode: {
        label: 'OpenCode',
        description: 'OpenCode CLI',
        binarySetting: 'ai.agentBinaryPathOpencode',
        defaultBinary: 'opencode',
    },
};

const SCAN_DEPTH_LABELS: Record<AgentScanDepth, string> = {
    developer: 'Developer Scan',
    team: 'Team Scan',
    security: 'Security Scan',
    audit: 'Audit Scan',
};

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

    public async syncConfigurationState(): Promise<void> {
        this._postMessage({ type: 'configurationState', state: await this._getConfigurationState() });
    }

    public async startWorkspaceScan(): Promise<void> {
        await this._handleScanRequest();
    }

    private _getEnabledScannerIds(): string[] {
        const config = vscode.workspace.getConfiguration('backbrain');
        return config.get<string[]>('enabledScanners', DEFAULT_ENABLED_SCANNERS)
            .filter(scannerId => scannerId in SCANNER_METADATA);
    }

    private _getSelectedScannerNames(): string[] {
        const config = vscode.workspace.getConfiguration('backbrain');
        const scannerNames = this._getEnabledScannerIds();
        const agentReviewEnabled = config.get<boolean>('ai.agentReviewEnabled', false);
        const enabledAgentBackends = config.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']);
        if (agentReviewEnabled && enabledAgentBackends.length > 0) {
            scannerNames.push('agent-review');
        }
        return scannerNames;
    }

    private async _getConfigurationState(): Promise<ConfigurationState> {
        const config = vscode.workspace.getConfiguration('backbrain');
        const enabledScanners = new Set(this._getEnabledScannerIds());
        const scannerStatuses = await this._securityService.getScannerStatuses();
        const statusMap = new Map(scannerStatuses.map(status => [status.id, status]));
        const scanDepth = config.get<AgentScanDepth>('ai.agentScanDepth', 'developer');

        return {
            scanners: DEFAULT_ENABLED_SCANNERS.map(scannerId => {
                const metadata = SCANNER_METADATA[scannerId]!;
                return {
                    id: scannerId,
                    label: metadata.label,
                    description: metadata.description,
                    enabled: enabledScanners.has(scannerId),
                    available: statusMap.get(scannerId)?.available ?? false,
                };
            }),
            agentBackends: await this._getAgentBackendStates(),
            agentReviewEnabled: config.get<boolean>('ai.agentReviewEnabled', false),
            scanDepth,
            scanDepthLabel: SCAN_DEPTH_LABELS[scanDepth],
        };
    }

    private async _getAgentBackendStates(): Promise<ConfigurationState['agentBackends']> {
        const config = vscode.workspace.getConfiguration('backbrain');
        const enabledBackends = new Set(config.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']));
        const preferredBackend = config.get<AgentBackendId>('ai.agentPreferredBackend', 'codex');

        return Promise.all((Object.keys(AGENT_BACKENDS) as AgentBackendId[]).map(async (backendId) => {
            const metadata = AGENT_BACKENDS[backendId];
            const configuredBinary = config.get<string>(metadata.binarySetting, '').trim();
            const binaryPath = configuredBinary || metadata.defaultBinary;
            const availability = await this._checkAgentBackendAvailability(backendId, binaryPath);
            return {
                id: backendId,
                label: metadata.label,
                description: metadata.description,
                enabled: enabledBackends.has(backendId),
                preferred: preferredBackend === backendId,
                ...availability,
            };
        }));
    }

    private async _checkAgentBackendAvailability(
        backendId: AgentBackendId,
        binaryPath: string,
    ): Promise<{ available: boolean; authenticated?: boolean }> {
        if (backendId === 'gemini') {
            const installer = new GeminiCliInstaller();
            const available = binaryPath === 'gemini'
                ? await installer.isInstalled()
                : await this._checkCliAvailable(binaryPath);
            if (!available) {
                return { available: false, authenticated: false };
            }
            return {
                available: true,
                authenticated: await installer.isAuthenticated(),
            };
        }

        return { available: await this._checkCliAvailable(binaryPath) };
    }

    private async _checkCliAvailable(binaryPath: string): Promise<boolean> {
        try {
            await execFileAsync(binaryPath, ['--version'], {
                timeout: 10000,
                maxBuffer: 1024 * 1024,
            });
            return true;
        } catch {
            return false;
        }
    }

    private async _updateConfiguration<T>(key: string, value: T): Promise<void> {
        await vscode.workspace.getConfiguration('backbrain').update(key, value, vscode.ConfigurationTarget.Workspace);
        await this.syncConfigurationState();
    }

    private async _handleScannerSelection(scannerId: string, enabled: boolean): Promise<void> {
        if (!(scannerId in SCANNER_METADATA)) {
            return;
        }
        const enabledScanners = new Set(this._getEnabledScannerIds());
        if (enabled) {
            enabledScanners.add(scannerId);
        } else {
            enabledScanners.delete(scannerId);
        }
        await this._updateConfiguration('enabledScanners', Array.from(enabledScanners));
    }

    private async _handleAgentBackendSelection(backendId: AgentBackendId, enabled: boolean): Promise<void> {
        const config = vscode.workspace.getConfiguration('backbrain');
        const enabledBackends = new Set(config.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']));
        if (enabled) {
            enabledBackends.add(backendId);
        } else {
            enabledBackends.delete(backendId);
        }

        if (enabledBackends.size === 0) {
            await this._updateConfiguration('ai.agentReviewEnabled', false);
        }

        await this._updateConfiguration('ai.agentBackends', Array.from(enabledBackends));
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
                    if (message.target === 'file') {
                        await this._handleScanFileRequest();
                    } else {
                        await this._handleScanRequest(message.target ?? 'workspace');
                    }
                    break;

                case 'requestScanFile':
                    await this._handleScanFileRequest();
                    break;

                case 'refreshConfiguration':
                    await this.syncConfigurationState();
                    break;

                case 'updateScannerSelection':
                    await this._handleScannerSelection(message.scannerId, message.enabled);
                    break;

                case 'updateAgentReviewEnabled':
                    await this._updateConfiguration('ai.agentReviewEnabled', message.enabled);
                    break;

                case 'updateAgentBackendSelection':
                    await this._handleAgentBackendSelection(message.backendId, message.enabled);
                    break;

                case 'updateAgentPreferredBackend':
                    await this._updateConfiguration('ai.agentPreferredBackend', message.backendId);
                    break;

                case 'updateScanDepth':
                    await this._updateConfiguration('ai.agentScanDepth', message.depth);
                    this.setScanDepthTier(SCAN_DEPTH_LABELS[message.depth]);
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
    private async _handleScanRequest(target: Exclude<ScanTarget, 'file'> = 'workspace'): Promise<void> {
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

        try {
            const scanQueue = await this._resolveScanPaths(target);
            await this._scanPaths(scanQueue, target);
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

    private async _resolveScanPaths(target: Exclude<ScanTarget, 'file'>): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
        }
        const root = workspaceFolders[0]!.uri;

        if (target === 'custom') {
            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: true,
                defaultUri: root,
                openLabel: 'Scan',
            });
            return (selected || []).filter(uri => uri.scheme === 'file').map(uri => uri.fsPath);
        }

        if (target === 'changed') {
            try {
                const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
                    cwd: root.fsPath,
                    timeout: 10000,
                    maxBuffer: 1024 * 1024,
                });
                return stdout
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean)
                    .map(relativePath => vscode.Uri.joinPath(root, relativePath).fsPath);
            } catch (error) {
                logger.warn('Failed to resolve changed files for scan', { error });
                throw new Error('Could not determine changed files for this workspace.');
            }
        }

        // Workspace scan: find all supported files and prioritize active/open files.
        const extensions = await this._securityService.getSupportedExtensions();
        const extensionPattern = extensions.map(ext => ext.replace('.', '')).join(',');
        const globPattern = `**/*.{${extensionPattern}}`;

        const config = vscode.workspace.getConfiguration('backbrain');
        const defaultExcludes = ['node_modules', 'dist', 'build', '.git', 'out', '.vscode'];
        const userExcludes = config.get<string[]>('excludePaths', []);
        const excludePaths = Array.from(new Set([...defaultExcludes, ...userExcludes]));
        const excludeGlob = `**/{${excludePaths.join(',')}}/**`;
        logger.debug(`Using exclude pattern: ${excludeGlob}`);

        const files = await vscode.workspace.findFiles(globPattern, excludeGlob, 5000);
        const activeEditor = vscode.window.activeTextEditor;
        const activePath = (
            activeEditor &&
            !activeEditor.document.isUntitled &&
            activeEditor.document.uri.scheme === 'file'
        ) ? activeEditor.document.uri.fsPath : null;

        const openDocuments = vscode.workspace.textDocuments
            .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file' && doc.uri.fsPath !== activePath)
            .map(doc => doc.uri.fsPath);

        const queuedPaths = new Set<string>();
        const scanQueue: string[] = [];

        if (activePath) {
            scanQueue.push(activePath);
            queuedPaths.add(activePath);
        }

        openDocuments.forEach(path => {
            if (!queuedPaths.has(path)) {
                scanQueue.push(path);
                queuedPaths.add(path);
            }
        });

        files.map(f => f.fsPath).forEach(path => {
            if (!queuedPaths.has(path)) {
                scanQueue.push(path);
                queuedPaths.add(path);
            }
        });

        return scanQueue;
    }

    private async _scanPaths(scanQueue: string[], target: ScanTarget): Promise<void> {
        this._isScanning = true;
        this._lastScanError = null;
        this._lastBatchProgress = null;
        this._scanStatus = null;
        this._scanCancelTokenSource = new vscode.CancellationTokenSource();
        const token = this._scanCancelTokenSource.token;

        this._postMessage({ type: 'scanStarted' });
        logger.info('Starting scan', { target, files: scanQueue.length });

        const totalFiles = scanQueue.length;
        let scannedCount = 0;
        const batchSize = 50;
        const startTime = Date.now();
        const selectedScanners = this._getSelectedScannerNames();

        this._issues = [];

        if (totalFiles === 0) {
            this.setStatus('info', 'Scan complete: no matching files found.');
            this._postMessage({ type: 'scanComplete', issues: [] });
            return;
        }

        for (let i = 0; i < totalFiles; i += batchSize) {
            if (token.isCancellationRequested) break;

            const batch = scanQueue.slice(i, i + batchSize);
            const batchStartTime = Date.now();

            const results = await this._securityService.scan(batch, {
                scanners: selectedScanners,
                onStatus: (update) => this.updateScanStatus(update),
            });

            const newIssues = results.issues.map(toIssueData);
            this._issues.push(...newIssues);

            scannedCount += batch.length;
            const batchDuration = Date.now() - batchStartTime;

            logger.debug(`Batch ${Math.floor(i / batchSize) + 1} complete: ${batch.length} files in ${batchDuration}ms`);

            this._postMessage({
                type: 'issuesUpdated',
                issues: newIssues,
                batchInfo: { current: scannedCount, total: totalFiles }
            });
            this._lastBatchProgress = { current: scannedCount, total: totalFiles };

            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const totalDuration = Date.now() - startTime;
        logger.info('Scan complete', { target, issues: this._issues.length, durationMs: totalDuration });
        this.setStatus('info', `Scan complete: ${this._issues.length} issue(s) found in ${Math.round(totalDuration / 100) / 10}s.`);
        this._postMessage({ type: 'scanComplete', issues: this._issues });
    }

    /**
     * Handle scan file request from webview
     */
    private async _handleScanFileRequest(): Promise<void> {
        if (this._isScanning) {
            logger.warn('Scan already in progress, skipping current-file request');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            this._postMessage({ type: 'scanError', error: 'No active file selected' });
            return;
        }

        this._isScanning = true;
        this._lastScanError = null;
        this._lastBatchProgress = null;
        this._scanStatus = null;
        this._postMessage({ type: 'scanStarted' });

        try {
            const filePath = editor.document.uri.fsPath;
            const content = editor.document.getText();
            const result = await this._securityService.scanFile(filePath, content, {
                scanners: this._getSelectedScannerNames(),
                onStatus: (update) => this.updateScanStatus(update),
            });
            const issueData = result.issues.map(toIssueData);
            this._issues = issueData;
            this._postMessage({ type: 'scanComplete', issues: issueData });
        } catch (error) {
            logger.error('Current file scan failed', { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._lastScanError = errorMessage;
            this._postMessage({ type: 'scanError', error: errorMessage });
        } finally {
            this._isScanning = false;
        }
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
        void this.syncConfigurationState();
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
