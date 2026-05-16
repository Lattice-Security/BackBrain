import React, { useState, useEffect } from 'react';
import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    vsCodeProgressRing
} from '@vscode/webview-ui-toolkit';
import { vscode } from './messages';
import type { IssueData, ExtensionMessage, FixData } from './messages';
import { IssueList } from './components/IssueList';
import { ErrorBoundary, ErrorCard } from './components/ErrorBoundary';
import './styles/theme.css';

// Register VS Code Web Components
provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeProgressRing());

type ExplanationState = {
    content: string;
    loading: boolean;
    error: string | null;
    provider: string | null;
};

const App: React.FC = () => {
    // Initialize state from VS Code persistence if available
    const initialState = vscode.getState() as { issues?: IssueData[]; scanDepthTier?: string } | undefined;
    const [issues, setIssues] = useState<IssueData[]>(initialState?.issues || []);
    const [scanDepthTier, setScanDepthTier] = useState<string>(initialState?.scanDepthTier || 'Developer');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
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
                    setBatchProgress(null);
                    break;
                case 'scanComplete':
                    setIssues(message.issues);
                    setLoading(false);
                    setBatchProgress(null);
                    setScanStatus(null);
                    break;
                case 'issuesUpdated':
                    setIssues(prev => {
                        const issueMap = new Map(prev.map(i => [i.id, i]));
                        message.issues.forEach(i => issueMap.set(i.id, i));
                        return Array.from(issueMap.values());
                    });
                    if (message.batchInfo) {
                        setBatchProgress(message.batchInfo);
                    }
                    break;
                case 'scanError':
                    setError(message.error);
                    setLoading(false);
                    break;
                case 'scanStatus':
                    setScanStatus(message);
                    break;
                case 'statusUpdate':
                    // No longer using the inline status card — info goes into scan status
                    break;
                case 'statusClear':
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

    return (
        <ErrorBoundary>
            {/* ── Panel Header ── */}
            <div className="bb-panel-header">
                <div className="bb-panel-header__brand">
                    {/* Shield icon (inline SVG) */}
                    <svg
                        className="bb-panel-header__shield"
                        width="15" height="15"
                        viewBox="0 0 16 16"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path
                            d="M8 1L2 3.5V8C2 11.3137 4.68629 14 8 14C11.3137 14 14 11.3137 14 8V3.5L8 1Z"
                            fill="currentColor"
                            opacity="0.9"
                        />
                    </svg>
                    <span className="bb-panel-header__title">BackBrain</span>
                </div>
                <div className="bb-panel-header__actions">
                    <button
                        className={`bb-ghost-btn${activeScannerMode === 'file' ? ' bb-ghost-btn--active' : ''}`}
                        onClick={handleScanFile}
                        disabled={loading}
                        title="Scan active file"
                    >
                        Scan File
                    </button>
                    <button
                        className={`bb-ghost-btn${activeScannerMode === 'workspace' ? ' bb-ghost-btn--active' : ''}`}
                        onClick={handleScan}
                        disabled={loading}
                        title="Scan entire workspace"
                    >
                        Workspace
                    </button>
                </div>
            </div>

            {/* ── Scan Depth Row ── */}
            <div className="bb-depth-row">
                <span className="bb-depth-row__label">Scan depth</span>
                <span className="bb-depth-row__badge">{scanDepthTier}</span>
            </div>

            {/* ── Error Card (scan errors) ── */}
            {error && (
                <div style={{ padding: '0 var(--bb-spacing-xl)' }}>
                    <ErrorCard
                        error={error}
                        onRetry={handleScan}
                    />
                </div>
            )}

            {/* ── Issue List ── */}
            <div className="bb-panel-body">
                <IssueList
                    issues={issues}
                    loading={loading}
                    activeFix={activeFix}
                    explanations={explanations}
                    onClearActiveFix={() => setActiveFix(null)}
                    scanStatus={scanStatus}
                    batchProgress={batchProgress}
                    scanDepthLabel={scanDepthTier}
                />
            </div>
        </ErrorBoundary>
    );
};

export default App;
