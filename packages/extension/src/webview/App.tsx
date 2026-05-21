import { useEffect, useMemo, useState } from 'react';
import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    vsCodeProgressRing
} from '@vscode/webview-ui-toolkit';
import { vscode } from './messages';
import type {
    AgentBackendId,
    AgentScanDepth,
    ConfigurationState,
    ExtensionMessage,
    FixData,
    IssueData,
    ScanTarget,
} from './messages';
import { IssueItem } from './components/IssueItem';
import { ErrorBoundary, ErrorCard } from './components/ErrorBoundary';
import './styles/theme.css';

provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeProgressRing());

type ExplanationState = {
    content: string;
    loading: boolean;
    error: string | null;
    provider: string | null;
};

type TabId = 'scan' | 'issues' | 'agents';
type SortMethod = 'severity' | 'filename';
type FilterMethod = 'all' | 'ai' | 'deterministic';

const SCAN_TARGETS: Array<{ id: ScanTarget; label: string; description: string; icon: string }> = [
    { id: 'file', label: 'Current file', description: 'Active editor only', icon: 'F' },
    { id: 'workspace', label: 'Workspace', description: 'All project files', icon: 'W' },
    { id: 'changed', label: 'Changed files', description: 'Git diff vs HEAD', icon: 'D' },
    { id: 'custom', label: 'Custom path', description: 'Pick files or folders', icon: 'P' },
];

const DEPTHS: Array<{ id: AgentScanDepth; label: string; detail: string }> = [
    { id: 'developer', label: 'Developer', detail: '2 agents · 3s delay' },
    { id: 'team', label: 'Team', detail: '3 agents · 2s delay' },
    { id: 'security', label: 'Security', detail: '4 agents · 1s delay' },
    { id: 'audit', label: 'Audit', detail: '6 agents · no delay' },
];

const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
};

const phaseLabels: Record<string, string> = {
    deterministic: 'Running deterministic scanners...',
    'agent-planner': 'AI planner creating specialists...',
    'agent-specialists': 'Specialist agents reviewing code...',
    'agent-aggregator': 'Aggregating findings...',
    'agent-verification': 'Verifying findings...',
    complete: 'Scan complete',
    degraded: 'Scan completed with warnings',
    skipped: 'Scan skipped',
};

const phaseProgress: Record<string, number> = {
    deterministic: 25,
    'agent-planner': 50,
    'agent-specialists': 75,
    'agent-aggregator': 90,
    'agent-verification': 95,
    complete: 100,
};

const phaseIndex: Record<string, number> = {
    deterministic: 0,
    'agent-planner': 1,
    'agent-specialists': 2,
    'agent-aggregator': 3,
    'agent-verification': 3,
    complete: 4,
};

const defaultConfiguration: ConfigurationState = {
    scanners: [],
    agentBackends: [],
    agentReviewEnabled: false,
    scanDepth: 'developer',
    scanDepthLabel: 'Developer Scan',
};

const ALL_SPECIALISTS = [
    { name: 'AI Orchestration Security', focus: 'prompt injection, sandbox escape' },
    { name: 'CLI Credential Auditor', focus: 'credential handling, auth flows' },
    { name: 'System Call Sentinel', focus: 'command injection, subprocess execution' },
    { name: 'Data Flow Inspector', focus: 'data leakage, logging exposure' },
    { name: 'Access Control Auditor', focus: 'path traversal, file permissions' },
    { name: 'Dependency Integrity Agent', focus: 'version safety, library imports' },
];

const getDepthAgentCount = (depth: AgentScanDepth): number => {
    switch (depth) {
        case 'developer': return 2;
        case 'team': return 3;
        case 'security': return 4;
        case 'audit': return 6;
        default: return 2;
    }
};

function basename(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

const App = () => {
    const initialState = vscode.getState() as { issues?: IssueData[]; scanDepthTier?: string } | undefined;
    const [issues, setIssues] = useState<IssueData[]>(initialState?.issues || []);
    const [configuration, setConfiguration] = useState<ConfigurationState>(defaultConfiguration);
    const [scanDepthTier, setScanDepthTier] = useState<string>(initialState?.scanDepthTier || 'Developer Scan');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scanStatus, setScanStatus] = useState<Extract<ExtensionMessage, { type: 'scanStatus' }> | null>(null);
    const [activeFix, setActiveFix] = useState<{ issueId: string; fix: FixData } | null>(null);
    const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
    const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});
    const [activeTab, setActiveTab] = useState<TabId>('scan');
    const [selectedTarget, setSelectedTarget] = useState<ScanTarget>('workspace');
    const [sortMethod, setSortMethod] = useState<SortMethod>('severity');
    const [filterMethod, setFilterMethod] = useState<FilterMethod>('all');
    const [expandedSpec, setExpandedSpec] = useState<Record<string, boolean>>({});

    useEffect(() => {
        vscode.setState({ issues, scanDepthTier });
    }, [issues, scanDepthTier]);

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
                    setActiveTab('issues');
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
                case 'configurationState':
                    setConfiguration(message.state);
                    setScanDepthTier(message.state.scanDepthLabel);
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
                        [message.issueId]: { content: '', loading: true, error: null, provider: message.provider ?? null },
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
                    vscode.postMessage({ type: 'requestScan', target: selectedTarget === 'file' ? 'workspace' : selectedTarget });
                    break;
                case 'fixReverted':
                    vscode.postMessage({ type: 'requestScan', target: selectedTarget === 'file' ? 'workspace' : selectedTarget });
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        vscode.postMessage({ type: 'ready' });
        vscode.postMessage({ type: 'refreshConfiguration' });
        return () => window.removeEventListener('message', handleMessage);
    }, [selectedTarget]);

    const counts = useMemo(() => {
        return issues.reduce((acc, issue) => {
            acc[issue.severity] = (acc[issue.severity] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
    }, [issues]);

    const groupedIssues = useMemo(() => {
        const filtered = issues.filter(issue => {
            if (filterMethod === 'ai') {
                return issue.sourceType === 'agent-only' || issue.sourceType === 'agent-grounded';
            }
            if (filterMethod === 'deterministic') {
                return issue.sourceType === 'deterministic';
            }
            return true;
        });

        const sorted = [...filtered].sort((a, b) => {
            if (sortMethod === 'filename') {
                const fileCompare = basename(a.filePath).localeCompare(basename(b.filePath));
                if (fileCompare !== 0) return fileCompare;
            }
            const severityCompare = (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
            if (severityCompare !== 0) return severityCompare;
            return a.filePath.localeCompare(b.filePath);
        });

        const groups: Array<{ filePath: string; issues: IssueData[] }> = [];
        const groupMap = new Map<string, IssueData[]>();
        sorted.forEach(issue => {
            if (!groupMap.has(issue.filePath)) {
                const group: IssueData[] = [];
                groupMap.set(issue.filePath, group);
                groups.push({ filePath: issue.filePath, issues: group });
            }
            groupMap.get(issue.filePath)!.push(issue);
        });
        return groups;
    }, [issues, filterMethod, sortMethod]);

    const startScan = () => {
        setError(null);
        if (selectedTarget === 'file') {
            vscode.postMessage({ type: 'requestScanFile' });
        } else {
            vscode.postMessage({ type: 'requestScan', target: selectedTarget });
        }
    };

    const progressPct = batchProgress
        ? Math.round((batchProgress.current / Math.max(1, batchProgress.total)) * 100)
        : scanStatus
            ? phaseProgress[scanStatus.phase] ?? 10
            : loading
                ? 10
                : 0;
    const currentPhase = scanStatus?.phase ?? 'deterministic';
    const currentPhaseIndex = phaseIndex[currentPhase] ?? 0;

    return (
        <ErrorBoundary>
            <div className="bb-shell">
                <header className="bb-header">
                    <div className="bb-brand">
                        <span className="bb-brand-icon">B</span>
                        <span>BackBrain</span>
                    </div>
                    <div className="bb-header-actions">
                        <button className="bb-icon-button" onClick={() => vscode.postMessage({ type: 'refreshConfiguration' })} title="Refresh availability">
                            ↻
                        </button>
                    </div>
                </header>

                <nav className="bb-tab-row">
                    {(['scan', 'issues', 'agents'] as TabId[]).map(tab => (
                        <button
                            key={tab}
                            className={`bb-tab${activeTab === tab ? ' bb-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab)}
                        >
                            {tab === 'scan' ? 'Scan' : tab === 'issues' ? 'Issues' : 'Agents'}
                        </button>
                    ))}
                </nav>

                {activeTab === 'scan' && (
                    <main className="bb-view">
                        {loading && (
                            <section className="bb-progress-card">
                                <div className="bb-progress-label">{phaseLabels[currentPhase] ?? scanStatus?.message ?? 'Scanning...'}</div>
                                <div className="bb-progress-sub">
                                    {batchProgress
                                        ? `${batchProgress.current} of ${batchProgress.total} files`
                                        : scanStatus?.scanner ?? scanStatus?.backend ?? 'Preparing scan'}
                                </div>
                                <div className="bb-progress-track">
                                    <div className="bb-progress-fill" style={{ width: `${progressPct}%` }} />
                                </div>
                                <div className="bb-phase-row">
                                    {['Deterministic', 'Planner', 'Specialists', 'Aggregator'].map((label, index) => (
                                        <span
                                            key={label}
                                            className={`bb-phase ${index < currentPhaseIndex ? 'bb-phase--done' : index === currentPhaseIndex ? 'bb-phase--current' : ''}`}
                                            title={label}
                                        />
                                    ))}
                                </div>
                                {configuration.agentReviewEnabled && (
                                    <div style={{ marginTop: '12px', borderTop: '0.5px solid var(--bb-color-border)', paddingTop: '10px' }}>
                                        <div className="bb-section-title" style={{ padding: 0, marginBottom: '6px', fontSize: '10px' }}>Agent specialists</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                            {(() => {
                                                const totalAgents = getDepthAgentCount(configuration.scanDepth);
                                                const specs = ALL_SPECIALISTS.slice(0, totalAgents);
                                                
                                                if (currentPhase === 'deterministic') {
                                                    return (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', border: '0.5px solid var(--bb-color-border)', background: 'var(--bb-color-panel-soft)' }}>
                                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--bb-color-panel-strong)', flexShrink: 0 }} />
                                                            <div style={{ fontSize: '11px', color: 'var(--bb-color-muted)', flex: 1 }}>Waiting for AI planner...</div>
                                                        </div>
                                                    );
                                                }
                                                
                                                if (currentPhase === 'agent-planner') {
                                                    return (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', border: '0.5px solid var(--bb-color-border)', background: 'var(--bb-color-panel-soft)' }}>
                                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--bb-color-link)', flexShrink: 0 }} />
                                                            <div style={{ fontSize: '11px', color: 'var(--bb-color-foreground)', flex: 1 }}>AI Planner creating specialists...</div>
                                                        </div>
                                                    );
                                                }

                                                return specs.map((spec, specIdx) => {
                                                    let statusColor = 'var(--bb-color-panel-strong)';
                                                    let statusText = 'waiting';
                                                    
                                                    if (currentPhase === 'agent-specialists') {
                                                        const msg = (scanStatus?.message || '').toLowerCase();
                                                        if (msg.includes('verifying') || msg.includes('aggregator')) {
                                                            statusColor = 'var(--bb-color-success)';
                                                            statusText = 'done';
                                                        } else {
                                                            // Dynamically mark earlier specialists as done/running
                                                            if (specIdx === 0) {
                                                                statusColor = 'var(--bb-color-link)';
                                                                statusText = 'running';
                                                            } else {
                                                                statusColor = 'var(--bb-color-panel-strong)';
                                                                statusText = 'waiting';
                                                            }
                                                        }
                                                    } else {
                                                        statusColor = 'var(--bb-color-success)';
                                                        statusText = 'done';
                                                    }

                                                    return (
                                                        <div key={spec.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', border: '0.5px solid var(--bb-color-border)', background: 'var(--bb-color-panel-soft)' }}>
                                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
                                                            <div style={{ fontSize: '11px', color: 'var(--bb-color-foreground)', flex: 1 }}>{spec.name}</div>
                                                            <span style={{ 
                                                                fontSize: '10px', 
                                                                padding: '1px 5px', 
                                                                borderRadius: '8px', 
                                                                background: statusText === 'done' ? 'color-mix(in srgb, var(--bb-color-success) 14%, var(--bb-color-panel))' : statusText === 'running' ? 'color-mix(in srgb, var(--bb-color-link) 14%, var(--bb-color-panel))' : 'var(--bb-color-panel-strong)', 
                                                                color: statusText === 'done' ? 'var(--bb-color-success)' : statusText === 'running' ? 'var(--bb-color-link)' : 'var(--bb-color-muted)' 
                                                            }}>
                                                                {statusText}
                                                            </span>
                                                        </div>
                                                    );
                                                });
                                            })()}
                                        </div>
                                    </div>
                                )}
                            </section>
                        )}

                        <section className="bb-section">
                            <div className="bb-section-title">Scan target</div>
                            <div className="bb-card-grid">
                                {SCAN_TARGETS.map(target => (
                                    <button
                                        key={target.id}
                                        className={`bb-scan-card${selectedTarget === target.id ? ' bb-scan-card--active' : ''}`}
                                        onClick={() => setSelectedTarget(target.id)}
                                        disabled={loading}
                                    >
                                        <span className="bb-card-icon">{target.icon}</span>
                                        <span className="bb-card-label">{target.label}</span>
                                        <span className="bb-card-detail">{target.description}</span>
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-title">Scan depth</div>
                            <div className="bb-depth-grid">
                                {DEPTHS.map(depth => (
                                    <button
                                        key={depth.id}
                                        className={`bb-depth-card${configuration.scanDepth === depth.id ? ' bb-depth-card--active' : ''}`}
                                        onClick={() => vscode.postMessage({ type: 'updateScanDepth', depth: depth.id })}
                                        disabled={loading}
                                    >
                                        <span className="bb-depth-name">{depth.label}</span>
                                        <span className="bb-depth-detail">{depth.detail}</span>
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-header">
                                <div className="bb-section-title">Scanners</div>
                                <button className="bb-small-button" onClick={() => vscode.postMessage({ type: 'refreshConfiguration' })}>
                                    Check
                                </button>
                            </div>
                            <div className="bb-scanner-pills">
                                {configuration.scanners.map(scanner => {
                                    const isUnavailable = !scanner.available;
                                    const pillClass = [
                                        'bb-scanner-pill',
                                        isUnavailable
                                            ? 'bb-scanner-pill--unavailable'
                                            : scanner.enabled
                                                ? 'bb-scanner-pill--enabled'
                                                : '',
                                    ].filter(Boolean).join(' ');
                                    return (
                                        <button
                                            key={scanner.id}
                                            className={pillClass}
                                            onClick={() => {
                                                if (isUnavailable) return;
                                                vscode.postMessage({ type: 'updateScannerSelection', scannerId: scanner.id, enabled: !scanner.enabled });
                                            }}
                                            disabled={loading || isUnavailable}
                                            title={isUnavailable ? `${scanner.label} is not installed` : scanner.description}
                                            aria-pressed={scanner.enabled}
                                        >
                                            <span className="bb-scanner-pill-dot" />
                                            {scanner.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-header" style={{ marginBottom: '8px' }}>
                                <div className="bb-section-title">AI Agent Review</div>
                                <label className={`bb-switch ${configuration.agentReviewEnabled ? 'bb-switch--active' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={configuration.agentReviewEnabled}
                                        onChange={event => vscode.postMessage({ type: 'updateAgentReviewEnabled', enabled: event.currentTarget.checked })}
                                        disabled={loading}
                                        style={{ display: 'none' }}
                                    />
                                    <span className="bb-switch-slider" />
                                </label>
                            </div>
                            {configuration.agentReviewEnabled && (
                                <div className="bb-toggle-list" style={{ marginTop: '8px' }}>
                                    {configuration.agentBackends.map(backend => (
                                        <label key={backend.id} className={`bb-toggle-row bb-toggle-row--backend${backend.enabled ? ' bb-toggle-row--enabled' : ''}`}>
                                            <input
                                                type="checkbox"
                                                checked={backend.enabled}
                                                onChange={event => vscode.postMessage({ type: 'updateAgentBackendSelection', backendId: backend.id as AgentBackendId, enabled: event.currentTarget.checked })}
                                                disabled={loading}
                                            />
                                            <span className="bb-toggle-main">
                                                <span className="bb-toggle-label">{backend.label}</span>
                                                <span className="bb-toggle-detail">{backend.description}</span>
                                            </span>
                                            <button
                                                className={`bb-preferred-button${backend.preferred ? ' bb-preferred-button--active' : ''}`}
                                                onClick={event => {
                                                    event.preventDefault();
                                                    vscode.postMessage({ type: 'updateAgentPreferredBackend', backendId: backend.id as AgentBackendId });
                                                }}
                                                disabled={loading}
                                            >
                                                {backend.preferred ? 'Preferred' : 'Use first'}
                                            </button>
                                            <span className={`bb-status-pill${backend.available ? ' bb-status-pill--ok' : ' bb-status-pill--off'}`}>
                                                {backend.available ? backend.authenticated === false ? 'Needs login' : 'Available' : 'Missing'}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </section>

                        {error && (
                            <div className="bb-error-wrap">
                                <ErrorCard error={error} onRetry={startScan} />
                            </div>
                        )}

                        <div className="bb-start-row">
                            <button className="bb-start-button" onClick={startScan} disabled={loading}>
                                {loading ? 'Scanning...' : 'Start scan'}
                            </button>
                        </div>
                    </main>
                )}

                {activeTab === 'issues' && (
                    <main className="bb-view">
                        <section className="bb-stats-grid">
                            {(['critical', 'high', 'low'] as const).map(severity => (
                                <div className="bb-stat-card" key={severity}>
                                    <span className={`bb-stat-num bb-stat-num--${severity}`}>{counts[severity] || 0}</span>
                                    <span className="bb-stat-label">{severity}</span>
                                </div>
                            ))}
                        </section>

                        <div className="bb-risk-bar">
                            {(['critical', 'high', 'medium', 'low'] as const).map(severity => (
                                counts[severity] ? (
                                    <span
                                        key={severity}
                                        className={`bb-risk-segment bb-risk-segment--${severity}`}
                                        style={{ flex: counts[severity] }}
                                    />
                                ) : null
                            ))}
                        </div>

                        <div className="bb-controls-row">
                            <select className="bb-select" value={sortMethod} onChange={event => setSortMethod(event.target.value as SortMethod)}>
                                <option value="severity">Severity</option>
                                <option value="filename">File name</option>
                            </select>
                            <select className="bb-select" value={filterMethod} onChange={event => setFilterMethod(event.target.value as FilterMethod)}>
                                <option value="all">All</option>
                                <option value="ai">AI only</option>
                                <option value="deterministic">Deterministic</option>
                            </select>
                            <span className="bb-depth-pill">{scanDepthTier}</span>
                        </div>

                        {issues.length === 0 ? (
                            <div className="bb-empty-state">
                                <div className="bb-empty-title">No Issues Loaded</div>
                                <div className="bb-empty-copy">Start a scan to populate results.</div>
                            </div>
                        ) : (
                            groupedIssues.map(group => (
                                <section className="bb-file-group" key={group.filePath}>
                                    <div className="bb-file-header">
                                        <span title={group.filePath}>{basename(group.filePath)}</span>
                                        <span className="bb-file-count">{group.issues.length}</span>
                                    </div>
                                    {group.issues.map(issue => (
                                        <IssueItem
                                            key={issue.id}
                                            issue={issue}
                                            activeFix={activeFix?.issueId === issue.id ? activeFix.fix : null}
                                            explanation={explanations[issue.id] ?? null}
                                            onClearActiveFix={() => setActiveFix(null)}
                                        />
                                    ))}
                                </section>
                            ))
                        )}
                    </main>
                )}

                {activeTab === 'agents' && (
                    <main className="bb-view">
                        <section className="bb-section">
                            <div className="bb-section-title">
                                {configuration.agentReviewEnabled 
                                    ? `Last scan — ${configuration.scanDepthLabel} · ${getDepthAgentCount(configuration.scanDepth)} agents` 
                                    : 'Agent review is disabled'}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '8px' }}>
                                <div style={{ background: 'var(--bb-color-panel-soft)', borderRadius: '6px', padding: '7px', border: '0.5px solid var(--bb-color-border)', textAlign: 'center' }}>
                                    <div style={{ fontSize: '16px', fontWeight: 500, color: 'var(--bb-color-link)' }}>
                                        {configuration.agentReviewEnabled ? getDepthAgentCount(configuration.scanDepth) : 0}
                                    </div>
                                    <div style={{ fontSize: '10px', color: 'var(--bb-color-muted)' }}>Agents ran</div>
                                </div>
                                <div style={{ background: 'var(--bb-color-panel-soft)', borderRadius: '6px', padding: '7px', border: '0.5px solid var(--bb-color-border)', textAlign: 'center' }}>
                                    <div style={{ fontSize: '16px', fontWeight: 500, color: 'var(--bb-color-success)' }}>
                                        {configuration.agentReviewEnabled ? issues.filter(i => i.sourceType === 'agent-only' || i.sourceType === 'agent-grounded').length : 0}
                                    </div>
                                    <div style={{ fontSize: '10px', color: 'var(--bb-color-muted)' }}>Findings</div>
                                </div>
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-title">Specialists</div>
                            {!configuration.agentReviewEnabled ? (
                                <div className="bb-empty-state">
                                    <div className="bb-empty-title">Agent Review Disabled</div>
                                    <div className="bb-empty-copy">Enable Agent Review in the Scan tab to run AI specialists.</div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                    {(() => {
                                        const agentIssues = issues.filter(i => i.sourceType === 'agent-only' || i.sourceType === 'agent-grounded');
                                        const count = getDepthAgentCount(configuration.scanDepth);
                                        const activeSpecs = ALL_SPECIALISTS.slice(0, count);

                                        return activeSpecs.map((specTemplate, idx) => {
                                            const specName = specTemplate.name;
                                            const specFocus = specTemplate.focus;
                                            
                                            const specFindings = agentIssues.filter(issue => {
                                                const roles = issue.sourceRoles || [];
                                                if (roles.length > 0) {
                                                    return roles.includes(specName);
                                                }
                                                if (idx === 0) {
                                                    return roles.length === 0;
                                                }
                                                return false;
                                            });

                                            const isExpanded = !!expandedSpec[specName];
                                            const toggleSpec = (name: string) => {
                                                setExpandedSpec(prev => ({ ...prev, [name]: !prev[name] }));
                                            };

                                            return (
                                                <div 
                                                    key={specName} 
                                                    style={{ border: '0.5px solid var(--bb-color-border)', borderRadius: '7px', overflow: 'hidden' }}
                                                >
                                                    <div 
                                                        style={{ padding: '8px 10px', background: 'var(--bb-color-panel-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                                                        onClick={() => toggleSpec(specName)}
                                                    >
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                                                            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--bb-color-success)', flexShrink: 0 }} />
                                                            <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--bb-color-foreground)' }}>{specName}</span>
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                            <span style={{ 
                                                                fontSize: '10px', 
                                                                padding: '1px 5px', 
                                                                borderRadius: '4px', 
                                                                background: specFindings.length > 0 ? 'var(--bb-severity-high-bg)' : 'var(--bb-color-panel-strong)', 
                                                                color: specFindings.length > 0 ? 'var(--bb-severity-high)' : 'var(--bb-color-muted)' 
                                                            }}>
                                                                {specFindings.length} {specFindings.length === 1 ? 'finding' : 'findings'}
                                                            </span>
                                                            <span style={{ 
                                                                display: 'inline-block',
                                                                transform: isExpanded ? 'rotate(180deg)' : 'none',
                                                                transition: 'transform var(--bb-transition-fast)',
                                                                fontSize: '10px',
                                                                color: 'var(--bb-color-muted)'
                                                            }}>
                                                                ▼
                                                            </span>
                                                        </div>
                                                    </div>
                                                    {isExpanded && (
                                                        <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--bb-color-border)', background: 'var(--bb-color-panel)' }}>
                                                            <div style={{ fontSize: '10px', color: 'var(--bb-color-muted)', marginBottom: '6px' }}>
                                                                Backend: {configuration.agentBackends.find(b => b.enabled)?.label || 'Gemini'} · Focus: {specFocus}
                                                            </div>
                                                            {specFindings.length === 0 ? (
                                                                <div style={{ fontSize: '11px', color: 'var(--bb-color-muted)', fontStyle: 'italic', padding: '4px 0' }}>
                                                                    No findings. Codebase looks secure according to this specialist.
                                                                </div>
                                                            ) : (
                                                                specFindings.map(finding => (
                                                                    <div key={finding.id} className="spec-finding">
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                                                                            <span className={`bb-stat-label-badge bb-stat-label-badge--${finding.severity}`} style={{ fontSize: '9px', fontWeight: 500, padding: '1px 4px', borderRadius: '3px', textTransform: 'uppercase' }}>
                                                                                {finding.severity}
                                                                            </span>
                                                                            <span style={{ fontSize: '11px', color: 'var(--bb-color-foreground)', fontWeight: 500 }}>{finding.title}</span>
                                                                        </div>
                                                                        <div style={{ fontSize: '10px', color: 'var(--bb-color-muted)' }}>
                                                                            {basename(finding.filePath)}:{finding.line}
                                                                        </div>
                                                                    </div>
                                                                ))
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        });
                                    })()}
                                </div>
                            )}
                        </section>
                    </main>
                )}
            </div>
        </ErrorBoundary>
    );
};

export default App;
