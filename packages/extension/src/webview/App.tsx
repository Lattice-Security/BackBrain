import React, { useState, useEffect } from 'react';
import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    vsCodeProgressRing
} from '@vscode/webview-ui-toolkit';
import { vscode } from './messages';
import type { IssueData, ExtensionMessage, FixData } from './messages';
import { IssueList } from './components/IssueList';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/theme.css';

// Register VS Code Web Components
provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeProgressRing());

const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];

function mapScanError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('auth') || lower.includes('authentication')) {
        return 'Gemini CLI is not authenticated. Run gemini auth in your terminal then reload VS Code.';
    }
    if (lower.includes('rate') || lower.includes('429') || lower.includes('quota')) {
        return 'Gemini rate limit reached. Wait a moment and try again, or switch to a lower scan depth tier in settings.';
    }
    if (lower.includes('network') || lower.includes('econnrefused')) {
        return 'Cannot reach Gemini. Check your internet connection and try again.';
    }
    return `Unexpected error: ${raw}`;
}

type ExplanationState = {
    content: string;
    loading: boolean;
    error: string | null;
    provider: string | null;
};

const App: React.FC = () => {
    // Initialize state from VS Code persistence if available
    const initialState = vscode.getState() as { issues?: IssueData[], scanDepthTier?: string } | undefined;
    const [issues, setIssues] = useState<IssueData[]>(initialState?.issues || []);
    const [scanDepthTier, setScanDepthTier] = useState<string>(initialState?.scanDepthTier || 'Developer Scan');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<{ level: 'info' | 'warn' | 'error'; message: string } | null>(null);
    const [scanStatus, setScanStatus] = useState<Extract<ExtensionMessage, { type: 'scanStatus' }> | null>(null);
    const [activeFix, setActiveFix] = useState<{ issueId: string; fix: FixData } | null>(null);
    const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
    const [activeScannerMode, setActiveScannerMode] = useState<'file' | 'workspace'>('workspace');
    const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});

    // Persist state whenever it changes
    useEffect(() => {
        vscode.setState({ issues, scanDepthTier });
    }, [issues, scanDepthTier]);

    // Listen for messages from the extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'scanStarted':
                    setLoading(true);
                    setError(null);
                    setScanStatus(null);
                    break;
                case 'scanComplete':
                    setIssues(message.issues);
                    setLoading(false);
                    setBatchProgress(null);
                    break;
                case 'issuesUpdated':
                    setIssues(prev => {
                        // Merge issues, replacing existing ones by ID to avoid duplicates
                        const issueMap = new Map(prev.map(i => [i.id, i]));
                        message.issues.forEach(i => issueMap.set(i.id, i));
                        return Array.from(issueMap.values());
                    });
                    if (message.batchInfo) {
                        setBatchProgress(message.batchInfo);
                    }
                    break;
                case 'scanError':
                    setError(mapScanError(message.error));
                    setLoading(false);
                    break;
                case 'statusUpdate':
                    setStatus({ level: message.level, message: message.message });
                    break;
                case 'scanStatus':
                    setScanStatus(message);
                    break;
                case 'statusClear':
                    setStatus(null);
                    break;
                case 'setScanDepthTier':
                    setScanDepthTier(message.label);
                    break;
                case 'fixSuggested':
                    setActiveFix({ issueId: message.issueId, fix: message.fix });
                    break;
                case 'explanationStarted':
                    setExplanations(prev => ({
                        ...prev,
                        [message.issueId]: {
                            content: '',
                            loading: true,
                            error: null,
                            provider: message.provider ?? null,
                        },
                    }));
                    break;
                case 'explanationChunk':
                    setExplanations(prev => ({
                        ...prev,
                        [message.issueId]: {
                            content: (prev[message.issueId]?.content || '') + message.chunk,
                            loading: true,
                            error: null,
                            provider: prev[message.issueId]?.provider ?? null,
                        },
                    }));
                    break;
                case 'explanationComplete':
                    setExplanations(prev => ({
                        ...prev,
                        [message.issueId]: {
                            content: message.content,
                            loading: false,
                            error: null,
                            provider: message.provider ?? prev[message.issueId]?.provider ?? null,
                        },
                    }));
                    break;
                case 'explanationError':
                    setExplanations(prev => ({
                        ...prev,
                        [message.issueId]: {
                            content: prev[message.issueId]?.content || '',
                            loading: false,
                            error: message.error,
                            provider: message.provider ?? prev[message.issueId]?.provider ?? null,
                        },
                    }));
                    break;
                case 'fixApplied':
                    setActiveFix(null);
                    vscode.postMessage({ type: 'requestScan' });
                    break;
                case 'fixReverted':
                    vscode.postMessage({ type: 'requestScan' });
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        // Signal that the webview is ready
        vscode.postMessage({ type: 'ready' });

        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleScan = () => {
        setActiveScannerMode('workspace');
        vscode.postMessage({ type: 'requestScan' });
    };

    const handleScanFile = () => {
        setActiveScannerMode('file');
        vscode.postMessage({ type: 'requestScanFile' });
    };

    // Calculate issue counts by severity
    const counts = issues.reduce((acc, issue) => {
        acc[issue.severity] = (acc[issue.severity] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    return (
        <ErrorBoundary>
            <div style={{ padding: 'var(--bb-spacing-xl)' }}>
                {/* Header */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 'var(--bb-spacing-xl)',
                    paddingBottom: 'var(--bb-spacing-lg)',
                    borderBottom: '1px solid var(--bb-color-border)',
                }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: 'var(--bb-font-size-md)',
                        fontWeight: 'var(--bb-font-weight-semibold)',
                        color: 'var(--bb-color-foreground)',
                    }}>
                        Security Issues
                    </h2>
                    <vscode-button
                        appearance={activeScannerMode === 'file' ? 'primary' : 'secondary'}
                        onClick={handleScanFile}
                        disabled={loading || undefined}
                        style={{ marginRight: 'var(--bb-spacing-sm)' }}
                    >
                        File
                    </vscode-button>
                    <vscode-button
                        appearance={activeScannerMode === 'workspace' ? 'primary' : 'secondary'}
                        onClick={handleScan}
                        disabled={loading || undefined}
                    >
                        Workspace
                    </vscode-button>
                    <vscode-button
                        appearance="icon"
                        onClick={() => vscode.postMessage({ type: 'exportReport' })}
                        title="Export Report"
                        style={{ marginLeft: 'var(--bb-spacing-sm)' }}
                    >
                        <span className="codicon codicon-export"></span>
                    </vscode-button>
                </div>

                {/* Summary Badges */}
                {issues.length > 0 && (
                    <div style={{
                        display: 'flex',
                        gap: 'var(--bb-spacing-md)',
                        marginBottom: 'var(--bb-spacing-xl)',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                    }}>
                        <span style={{
                            fontSize: 'var(--bb-font-size-sm)',
                            padding: 'var(--bb-spacing-xs) var(--bb-spacing-md)',
                            borderRadius: 'var(--bb-border-radius-pill)',
                            backgroundColor: 'var(--bb-color-background-secondary)',
                            color: 'var(--bb-color-foreground)',
                            border: '1px solid var(--bb-color-border)',
                        }}>
                            {scanDepthTier}
                        </span>
                        {severityOrder.map(severity => {
                            const count = counts[severity] || 0;
                            if (count === 0) return null;

                            return (
                                <span
                                    key={severity}
                                    style={{
                                        fontSize: 'var(--bb-font-size-sm)',
                                        padding: 'var(--bb-spacing-xs) var(--bb-spacing-md)',
                                        borderRadius: 'var(--bb-border-radius-pill)',
                                        backgroundColor: 'var(--bb-color-badge-bg)',
                                        color: 'var(--bb-color-badge-fg)',
                                    }}
                                >
                                    {count} {severity}
                                </span>
                            );
                        })}
                        <span style={{
                            fontSize: 'var(--bb-font-size-sm)',
                            padding: 'var(--bb-spacing-xs) var(--bb-spacing-md)',
                            borderRadius: 'var(--bb-border-radius-pill)',
                            backgroundColor: 'var(--bb-color-background-secondary)',
                            color: 'var(--bb-color-foreground)',
                            marginLeft: 'auto',
                        }}>
                            Total: {issues.length}
                        </span>
                    </div>
                )}

                {/* Batch Progress */}
                {batchProgress && (
                    <div style={{
                        marginBottom: 'var(--bb-spacing-md)',
                        padding: 'var(--bb-spacing-sm)',
                        backgroundColor: 'var(--bb-color-background-secondary)',
                        borderRadius: 'var(--bb-border-radius-md)',
                    }}>
                        <div style={{
                            fontSize: 'var(--bb-font-size-sm)',
                            color: 'var(--bb-color-foreground)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: 'var(--bb-spacing-xs)'
                        }}>
                            <span>Scanning workspace...</span>
                            <span>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                        </div>
                        <div style={{
                            width: '100%',
                            height: '4px',
                            backgroundColor: 'var(--bb-color-border)',
                            borderRadius: '2px',
                            overflow: 'hidden'
                        }}>
                            <div style={{
                                width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                                height: '100%',
                                backgroundColor: 'var(--bb-color-badge-bg)',
                                transition: 'width 0.3s ease'
                            }} />
                        </div>
                        <div style={{
                            fontSize: 'var(--bb-font-size-xs)',
                            color: 'var(--bb-color-foreground-secondary)',
                            marginTop: 'var(--bb-spacing-xs)',
                            textAlign: 'right'
                        }}>
                            {batchProgress.current} / {batchProgress.total} files
                        </div>
                    </div>
                )}

                {scanStatus && (
                    <div style={{
                        marginBottom: 'var(--bb-spacing-md)',
                        padding: 'var(--bb-spacing-md)',
                        backgroundColor: scanStatus.level === 'warn'
                            ? 'var(--vscode-inputValidation-warningBackground, rgba(191, 144, 0, 0.15))'
                            : 'var(--bb-color-background-secondary)',
                        borderRadius: 'var(--bb-border-radius-md)',
                        border: `1px solid ${scanStatus.level === 'warn'
                            ? 'var(--vscode-inputValidation-warningBorder, #cca700)'
                            : 'var(--bb-color-border)'}`,
                    }}>
                        <div style={{
                            fontSize: 'var(--bb-font-size-sm)',
                            fontWeight: 'var(--bb-font-weight-semibold)',
                            color: 'var(--bb-color-foreground)',
                            marginBottom: 'var(--bb-spacing-xs)',
                            textTransform: 'capitalize',
                        }}>
                            {scanStatus.phase.replace(/-/g, ' ')}
                        </div>
                        <div style={{
                            fontSize: 'var(--bb-font-size-sm)',
                            color: 'var(--bb-color-foreground)',
                        }}>
                            {scanStatus.message}
                            {scanStatus.backend ? ` (${scanStatus.backend})` : ''}
                        </div>
                    </div>
                )}


                {/* Error Display */}
                {error && (
                    <div style={{
                        padding: 'var(--bb-spacing-lg)',
                        marginBottom: 'var(--bb-spacing-xl)',
                        borderRadius: 'var(--bb-border-radius-md)',
                        backgroundColor: 'var(--bb-color-error-bg)',
                        color: 'var(--bb-color-error)',
                        border: '1px solid var(--bb-color-error)',
                    }}>
                        <strong>Scan Error:</strong> {error}
                    </div>
                )}

                {status && (
                    <div style={{
                        padding: 'var(--bb-spacing-lg)',
                        marginBottom: 'var(--bb-spacing-xl)',
                        borderRadius: 'var(--bb-border-radius-md)',
                        backgroundColor: status.level === 'error'
                            ? 'var(--bb-color-error-bg)'
                            : status.level === 'warn'
                                ? 'var(--vscode-inputValidation-warningBackground, rgba(191, 144, 0, 0.15))'
                                : 'var(--bb-color-background-secondary)',
                        color: status.level === 'error'
                            ? 'var(--bb-color-error)'
                            : 'var(--bb-color-foreground)',
                        border: `1px solid ${status.level === 'error'
                            ? 'var(--bb-color-error)'
                            : status.level === 'warn'
                                ? 'var(--vscode-inputValidation-warningBorder, #cca700)'
                                : 'var(--bb-color-border)'}`,
                    }}>
                        <strong>BackBrain:</strong> {status.message}
                    </div>
                )}

                {/* Issue List */}
                <IssueList
                    issues={issues}
                    loading={loading}
                    activeFix={activeFix}
                    explanations={explanations}
                    onClearActiveFix={() => setActiveFix(null)}
                    scanStatus={scanStatus}
                    batchProgress={batchProgress}
                />
            </div>
        </ErrorBoundary>
    );
};

export default App;
