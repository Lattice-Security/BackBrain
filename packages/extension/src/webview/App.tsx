import { useEffect, useMemo, useState, useRef } from 'react';
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
    DebugStep,
    DebugStepStatus,
    ExtensionMessage,
    FixData,
    IssueData,
    ScanTarget,
} from './messages';
import { IssueItem } from './components/IssueItem';
import { Visualizer } from './components/Visualizer';
import { ErrorBoundary, ErrorCard } from './components/ErrorBoundary';
import './styles/theme.css';

provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeProgressRing());

type ExplanationState = {
    content: string;
    loading: boolean;
    error: string | null;
    provider: string | null;
};

type IconName =
    | 'alert'
    | 'bot'
    | 'check'
    | 'chevronDown'
    | 'circle'
    | 'file'
    | 'folder'
    | 'gitDiff'
    | 'play'
    | 'refresh'
    | 'search'
    | 'settings'
    | 'shield'
    | 'sliders'
    | 'spark'
    | 'users'
    | 'x'
    | 'zap'
    | 'graph';

type TabId = 'scan' | 'issues' | 'agents' | 'visualizer';
type SortMethod = 'severity' | 'filename';
type FilterMethod = 'all' | 'ai' | 'deterministic';

const ICON_PATHS: Record<IconName, string[]> = {
    alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0Z'],
    bot: ['M12 8V4H8', 'M8 4h8', 'M16 4h-4', 'M6 10h12a2 2 0 0 1 2 2v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a2 2 0 0 1 2-2Z', 'M9 15h.01', 'M15 15h.01'],
    check: ['M20 6 9 17l-5-5'],
    chevronDown: ['m6 9 6 6 6-6'],
    circle: ['M12 12h.01'],
    file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6', 'M9 15h6'],
    folder: ['M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
    gitDiff: ['M6 3v12', 'M6 15l-3-3', 'M6 15l3-3', 'M18 21V9', 'M18 9l-3 3', 'M18 9l3 3', 'M6 3h6a3 3 0 0 1 3 3v0'],
    play: ['M5 3l14 9-14 9Z'],
    refresh: ['M21 12a9 9 0 0 1-15.5 6.2L3 16', 'M3 21v-5h5', 'M3 12A9 9 0 0 1 18.5 5.8L21 8', 'M21 3v5h-5'],
    search: ['M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z', 'M16 16l5 5'],
    settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M3 12h2', 'M19 12h2', 'M12 3v2', 'M12 19v2', 'M5.6 5.6 7 7', 'M16.9 16.9l1.5 1.5', 'M18.4 5.6l-1.5 1.5', 'M7.1 16.9l-1.5 1.5'],
    shield: ['M12 2 4.5 5.4v5.7c0 4.6 3.1 8.8 7.5 10.1 4.4-1.3 7.5-5.5 7.5-10.1V5.4Z', 'M9 12l2 2 4-5'],
    sliders: ['M4 6h8', 'M16 6h4', 'M14 4v4', 'M4 12h4', 'M12 12h8', 'M10 10v4', 'M4 18h10', 'M18 18h2', 'M16 16v4'],
    spark: ['M12 2l1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5Z', 'M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z'],
    users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    zap: ['M13 2 3 14h8l-1 8 11-13h-8Z'],
    graph: ['M12 3v3', 'M19 9h-3.5', 'M5 9h3.5', 'M12 18v3', 'M12 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z', 'M19 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z', 'M5 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z'],
};

function Icon({ name, className }: { name: IconName; className?: string }) {
    return (
        <svg className={className ? `bb-icon ${className}` : 'bb-icon'} viewBox="0 0 24 24" aria-hidden="true">
            {ICON_PATHS[name].map((d, index) => (
                <path key={index} d={d} />
            ))}
        </svg>
    );
}

const SCAN_TARGETS: Array<{ id: ScanTarget; label: string; description: string; icon: IconName }> = [
    { id: 'file', label: 'Current file', description: 'Active editor only', icon: 'file' },
    { id: 'workspace', label: 'Workspace', description: 'All project files', icon: 'folder' },
    { id: 'changed', label: 'Changed files', description: 'Git diff vs HEAD', icon: 'gitDiff' },
    { id: 'custom', label: 'Custom path', description: 'Pick files or folders', icon: 'sliders' },
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

type LogLineKind = 'thinking' | 'done' | 'assistant' | 'command' | 'output' | 'tool' | 'plain';

function classifyLogLine(line: string): { kind: LogLineKind; prefix: string; body: string } {
    if (/^(opencode|codex|gemini):\s/i.test(line)) {
        const colonIdx = line.indexOf(':');
        const prefix = line.slice(0, colonIdx);
        const body = line.slice(colonIdx + 2);
        const isDone = /^(stop|complete|end|aggregat|verif)/i.test(body);
        return { kind: isDone ? 'done' : 'thinking', prefix, body };
    }
    if (/^assistant:\s/i.test(line)) {
        return { kind: 'assistant', prefix: 'assistant', body: line.replace(/^assistant:\s*/i, '') };
    }
    if (/^\$\s/.test(line)) {
        return { kind: 'command', prefix: '$', body: line.slice(2) };
    }
    if (/^  \S/.test(line)) {
        return { kind: 'output', prefix: '', body: line.trimStart() };
    }
    if (/^[\w_-]+:\s/.test(line)) {
        const colonIdx = line.indexOf(':');
        return { kind: 'tool', prefix: line.slice(0, colonIdx), body: line.slice(colonIdx + 2) };
    }
    return { kind: 'plain', prefix: '', body: line };
}

const LOG_KIND_STYLES: Record<LogLineKind, React.CSSProperties> = {
    thinking: { color: 'var(--bb-color-muted)', fontStyle: 'italic' },
    done:     { color: 'var(--bb-color-success)' },
    assistant:{ color: 'var(--bb-color-foreground)' },
    command:  { color: 'var(--bb-color-warning)' },
    output:   { color: 'var(--bb-color-subtle)', paddingLeft: '12px' },
    tool:     { color: 'var(--bb-color-link)' },
    plain:    { color: 'var(--bb-color-muted)' },
};

const LOG_KIND_PREFIX_STYLES: Record<LogLineKind, React.CSSProperties> = {
    thinking: { color: 'var(--bb-color-muted)', marginRight: '5px' },
    done:     { color: 'var(--bb-color-success)', marginRight: '5px' },
    assistant:{ color: 'var(--bb-color-muted)', marginRight: '5px' },
    command:  { color: 'var(--bb-color-warning)', marginRight: '5px' },
    output:   {},
    tool:     { color: 'var(--bb-color-link)', opacity: 0.7, marginRight: '4px' },
    plain:    {},
};

const OpenCodeTerminal: React.FC<{ logs: string[]; backend?: string }> = ({ logs }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [logs]);

    return (
        <div className="bb-terminal">
            <div className="bb-terminal-header">
                <span className="bb-terminal-dot bb-terminal-dot--red" />
                <span className="bb-terminal-dot bb-terminal-dot--yellow" />
                <span className="bb-terminal-dot bb-terminal-dot--green" />
                <span className="bb-terminal-title">Agent Output</span>
                <span className="bb-terminal-count">{logs.length}</span>
            </div>
            <div ref={containerRef} className="bb-terminal-body">
                {logs.length === 0 ? (
                    <span className="bb-terminal-empty">Waiting for agent output...</span>
                ) : (
                    logs.map((line, i) => {
                        const { kind, prefix, body } = classifyLogLine(line);
                        return (
                            <div key={i} className="bb-terminal-line" style={LOG_KIND_STYLES[kind]}>
                                {prefix && (
                                    <span className="bb-terminal-prefix" style={LOG_KIND_PREFIX_STYLES[kind]}>
                                        {kind === 'command' ? '$ ' : `${prefix}: `}
                                    </span>
                                )}
                                <span className="bb-terminal-body-text">{body}</span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

const App = () => {
    const initialState = vscode.getState() as {
        issues?: IssueData[];
        scanDepthTier?: string;
        selectedTarget?: ScanTarget;
        customPathsDisplayNames?: string[];
        changedFilesStatus?: { count?: number; error?: string; loading?: boolean } | null;
    } | undefined;
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
    const [selectedTarget, setSelectedTarget] = useState<ScanTarget>(initialState?.selectedTarget || 'workspace');
    const [customPathsDisplayNames, setCustomPathsDisplayNames] = useState<string[]>(initialState?.customPathsDisplayNames || []);
    const [changedFilesStatus, setChangedFilesStatus] = useState<{ count?: number; error?: string; loading?: boolean } | null>(initialState?.changedFilesStatus || null);

    const selectedTargetRef = useRef(selectedTarget);
    useEffect(() => {
        selectedTargetRef.current = selectedTarget;
    }, [selectedTarget]);
    const [sortMethod, setSortMethod] = useState<SortMethod>('severity');
    const [filterMethod, setFilterMethod] = useState<FilterMethod>('all');
    const [expandedSpec, setExpandedSpec] = useState<Record<string, boolean>>({});
    const [debugMode, setDebugMode] = useState(false);
    const [debugSteps, setDebugSteps] = useState<DebugStep[]>([]);
    const [debugPhase, setDebugPhase] = useState('');
    const [lastScanSpecialists, setLastScanSpecialists] = useState<Array<{ name: string; focus: string }>>([]);
    const [agentLogs, setAgentLogs] = useState<string[]>([]);
    const [rateLimitWarning, setRateLimitWarning] = useState<{ message: string; backend?: string; sessionId?: string } | null>(null);
    const [scanIncomplete, setScanIncomplete] = useState(false);

    useEffect(() => {
        vscode.setState({
            issues,
            scanDepthTier,
            selectedTarget,
            customPathsDisplayNames,
            changedFilesStatus
        });
    }, [issues, scanDepthTier, selectedTarget, customPathsDisplayNames, changedFilesStatus]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'scanStarted':
                    setLoading(true);
                    setError(null);
                    setScanStatus(null);
                    setBatchProgress(null);
                    setDebugSteps([]);
                    setAgentLogs([]);
                    setRateLimitWarning(null);
                    setScanIncomplete(false);
                    break;
                case 'scanComplete':
                    setIssues(message.issues);
                    setLoading(false);
                    setBatchProgress(null);
                    setScanStatus(null);
                    setAgentLogs([]);
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
                    if (message.errorCategory === 'rate-limit') {
                        setRateLimitWarning({ message: message.message, backend: message.backend, sessionId: message.sessionId });
                    }
                    if (message.agentLog) {
                        setAgentLogs(prev => [...prev.slice(-199), message.agentLog!]);
                    } else {
                        setAgentLogs(prev => {
                            const phaseLines: Record<string, string> = {
                                'deterministic':    'running deterministic scanners',
                                'agent-planner':    'planner running',
                                'agent-specialists':'specialist agents reviewing code',
                                'agent-aggregator': 'aggregating findings',
                                'agent-verification':'verifying findings',
                                'degraded':         'completed with warnings',
                                'complete':         'complete',
                            };
                            const synthetic = phaseLines[message.phase];
                            if (!synthetic) return prev;
                            if (prev[prev.length - 1] === synthetic) return prev;
                            return [...prev.slice(-199), synthetic];
                        });
                    }
                    if (message.phase === 'agent-specialists' && message.agents && message.agents.length > 0) {
                        setLastScanSpecialists(message.agents.map(name => ({
                            name,
                            focus: '',
                            backend: message.backend || '',
                            status: 'running',
                        })));
                    }
                    if (message.phase === 'degraded' || message.phase === 'complete') {
                        setScanIncomplete(message.phase === 'degraded');
                    }
                    break;
                case 'configurationState':
                    setConfiguration(message.state);
                    setScanDepthTier(message.state.scanDepthLabel);
                    break;
                case 'setScanDepthTier':
                    setScanDepthTier(message.label);
                    break;
                case 'customPathsSelected':
                    setCustomPathsDisplayNames(message.displayNames);
                    break;
                case 'changedFilesStatus':
                    setChangedFilesStatus({
                        count: message.count,
                        error: message.error,
                        loading: false,
                    });
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
                    vscode.postMessage({ type: 'requestScan', target: selectedTargetRef.current === 'file' ? 'workspace' : selectedTargetRef.current });
                    break;
                case 'fixReverted':
                    vscode.postMessage({ type: 'requestScan', target: selectedTargetRef.current === 'file' ? 'workspace' : selectedTargetRef.current });
                    break;
                case 'debugStatus':
                    setDebugSteps(message.steps);
                    setDebugPhase(message.phase);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        vscode.postMessage({ type: 'ready' });
        vscode.postMessage({ type: 'refreshConfiguration' });
        return () => window.removeEventListener('message', handleMessage);
    }, []);

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
                        <span className="bb-brand-icon"><Icon name="shield" /></span>
                        <span>BackBrain</span>
                    </div>
                    <div className="bb-header-actions">
                        <button
                            className={`bb-small-button${debugMode ? ' bb-small-button--active' : ''}`}
                            onClick={() => {
                                const next = !debugMode;
                                setDebugMode(next);
                                setDebugSteps([]);
                                if (!next) setLoading(false);
                                vscode.postMessage({ type: 'setDebugMode', enabled: next });
                            }}
                            title={debugMode ? 'Disable debug mode' : 'Enable debug mode'}
                            style={{ fontSize: '10px', padding: '2px 5px' }}
                        >
                            Debug
                        </button>
                        <button className="bb-icon-button" onClick={() => vscode.postMessage({ type: 'refreshConfiguration' })} title="Refresh availability">
                            <Icon name="refresh" />
                        </button>
                    </div>
                </header>

                <nav className="bb-tab-row">
                    {(['scan', 'issues', 'agents', 'visualizer'] as TabId[]).map(tab => (
                        <button
                            key={tab}
                            className={`bb-tab${activeTab === tab ? ' bb-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab)}
                        >
                            <Icon name={tab === 'scan' ? 'play' : tab === 'issues' ? 'shield' : tab === 'agents' ? 'users' : 'graph'} />
                            <span>{tab === 'scan' ? 'Scan' : tab === 'issues' ? 'Issues' : tab === 'agents' ? 'Agents' : 'Visualizer'}</span>
                        </button>
                    ))}
                </nav>

                {activeTab === 'scan' && (
                    <main className="bb-view">
                        {loading && debugMode && debugSteps.length > 0 ? (
                            <section className="bb-debug-panel">
                                <div className="bb-section-title" style={{ padding: '0 0 8px', fontSize: '10px' }}>
                                    Debug scan — {debugPhase}
                                </div>
                                <div className="bb-debug-steps">
                                    {debugSteps.map(step => (
                                        <div key={step.id} className={`bb-debug-step bb-debug-step--${step.status}`}>
                                            <span className={`bb-debug-dot bb-debug-dot--${step.status}`} />
                                            <span className="bb-debug-label">{step.label}</span>
                                            {step.message && <span className="bb-debug-msg">{step.message}</span>}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ) : loading && (
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
                                                const agentNames = scanStatus?.agents || [];
                                                
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
                                                            <div style={{ fontSize: 11, color: 'var(--bb-color-foreground)', flex: 1 }}>AI Planner creating specialists...</div>
                                                        </div>
                                                    );
                                                }

                                                return Array.from({ length: totalAgents }, (_, specIdx) => {
                                                    const agentName = agentNames[specIdx] || `Specialist ${specIdx + 1}`;
                                                    let statusColor = 'var(--bb-color-panel-strong)';
                                                    let statusText = 'waiting';
                                                    
                                                    if (currentPhase === 'agent-specialists') {
                                                        const msg = (scanStatus?.message || '').toLowerCase();
                                                        if (msg.includes('verifying') || msg.includes('aggregator')) {
                                                            statusColor = 'var(--bb-color-success)';
                                                            statusText = 'done';
                                                        } else {
                                                            const currentAgent = parseInt(msg.match(/agent\s+(\d+)/i)?.[1] || '1', 10) - 1;
                                                            if (specIdx < currentAgent) {
                                                                statusColor = 'var(--bb-color-success)';
                                                                statusText = 'done';
                                                            } else if (specIdx === currentAgent) {
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
                                                        <div key={specIdx} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', border: '0.5px solid var(--bb-color-border)', background: 'var(--bb-color-panel-soft)' }}>
                                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
                                                            <div style={{ fontSize: '11px', color: 'var(--bb-color-foreground)', flex: 1 }}>{agentName}</div>
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

                        {loading && configuration.agentReviewEnabled && (
                            <section className="bb-terminal-section">
                                <OpenCodeTerminal logs={agentLogs} />
                            </section>
                        )}

                        <section className="bb-section">
                            <div className="bb-section-title">Scan target</div>
                            <div className="bb-card-grid">
                                {SCAN_TARGETS.map(target => {
                                    const isSelected = selectedTarget === target.id;
                                    return (
                                        <div
                                            key={target.id}
                                            role="button"
                                            tabIndex={loading ? -1 : 0}
                                            className={`bb-scan-card${isSelected ? ' bb-scan-card--active' : ''}`}
                                            style={loading ? { opacity: 0.55, cursor: 'not-allowed', pointerEvents: 'none' } : undefined}
                                            onClick={() => {
                                                if (loading) return;
                                                setSelectedTarget(target.id);
                                                if (target.id === 'custom') {
                                                    vscode.postMessage({ type: 'selectCustomPaths' });
                                                } else if (target.id === 'changed') {
                                                    setChangedFilesStatus({ loading: true });
                                                    vscode.postMessage({ type: 'checkChangedFiles' });
                                                }
                                            }}
                                            onKeyDown={(e) => {
                                                if (loading) return;
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    setSelectedTarget(target.id);
                                                    if (target.id === 'custom') {
                                                        vscode.postMessage({ type: 'selectCustomPaths' });
                                                    } else if (target.id === 'changed') {
                                                        setChangedFilesStatus({ loading: true });
                                                        vscode.postMessage({ type: 'checkChangedFiles' });
                                                    }
                                                }
                                            }}
                                        >
                                            <span className="bb-card-icon"><Icon name={target.icon} /></span>
                                            <span className="bb-card-label">{target.label}</span>
                                            <span className="bb-card-detail">{target.description}</span>

                                            {target.id === 'custom' && customPathsDisplayNames.length > 0 && (
                                                <div style={{ marginTop: '8px', borderTop: '0.5px solid var(--bb-color-border)', paddingTop: '6px', width: '100%', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                    <div style={{ fontSize: '10px', color: 'var(--bb-color-foreground)', wordBreak: 'break-all', maxHeight: '48px', overflowY: 'auto' }}>
                                                        {customPathsDisplayNames.join(', ')}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        style={{
                                                            alignSelf: 'flex-start',
                                                            fontSize: '9px',
                                                            padding: '2px 6px',
                                                            background: 'var(--bb-color-panel-strong)',
                                                            border: '0.5px solid var(--bb-color-border)',
                                                            borderRadius: '3px',
                                                            cursor: 'pointer',
                                                            color: 'var(--bb-color-link)',
                                                            fontWeight: 'var(--bb-font-weight-medium)'
                                                        }}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            vscode.postMessage({ type: 'selectCustomPaths' });
                                                        }}
                                                    >
                                                        Change
                                                    </button>
                                                </div>
                                            )}

                                            {target.id === 'changed' && changedFilesStatus && (
                                                <div style={{ marginTop: '6px', fontSize: '10px', color: changedFilesStatus.error ? 'var(--bb-color-error)' : 'var(--bb-color-muted)' }}>
                                                    {changedFilesStatus.loading ? (
                                                        <span>Checking changed files...</span>
                                                    ) : changedFilesStatus.error ? (
                                                        <span>{changedFilesStatus.error}</span>
                                                    ) : changedFilesStatus.count === 0 ? (
                                                        <span>No changed files found</span>
                                                    ) : (
                                                        <span>{changedFilesStatus.count} changed file{changedFilesStatus.count === 1 ? '' : 's'} detected</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-title">Scan depth</div>
                            <div className="bb-depth-grid">
                                {DEPTHS.map(depth => (
                                    <button
                                        key={depth.id}
                                        type="button"
                                        className={`bb-depth-card${configuration.scanDepth === depth.id ? ' bb-depth-card--active' : ''}`}
                                        onClick={() => {
                                            setConfiguration(prev => ({ ...prev, scanDepth: depth.id, scanDepthLabel: depth.label + ' Scan' }));
                                            vscode.postMessage({ type: 'updateScanDepth', depth: depth.id });
                                        }}
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
                                            type="button"
                                            className={pillClass}
                                            onClick={() => {
                                                if (isUnavailable) return;
                                                setConfiguration(prev => ({
                                                    ...prev,
                                                    scanners: prev.scanners.map(s =>
                                                        s.id === scanner.id ? { ...s, enabled: !s.enabled } : s
                                                    ),
                                                }));
                                                vscode.postMessage({ type: 'updateScannerSelection', scannerId: scanner.id, enabled: !scanner.enabled });
                                            }}
                                            disabled={loading || isUnavailable}
                                            title={isUnavailable ? `${scanner.label} is not installed` : scanner.description}
                                            aria-pressed={scanner.enabled}
                                        >
                                            <Icon name={isUnavailable ? 'alert' : scanner.enabled ? 'check' : 'circle'} className="bb-scanner-pill-icon" />
                                            {scanner.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="bb-section">
                            <div className="bb-section-header" style={{ marginBottom: '8px' }}>
                                <div className="bb-section-title bb-section-title--with-icon">
                                    <Icon name="bot" />
                                    AI Agent Review
                                </div>
                                <label className={`bb-switch ${configuration.agentReviewEnabled ? 'bb-switch--active' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={configuration.agentReviewEnabled}
                                                onChange={event => {
                                                    const enabled = event.currentTarget.checked;
                                                    setConfiguration(prev => ({ ...prev, agentReviewEnabled: enabled }));
                                                    vscode.postMessage({ type: 'updateAgentReviewEnabled', enabled });
                                                }}
                                                disabled={loading}
                                                style={{ display: 'none' }}
                                    />
                                    <span className="bb-switch-slider" />
                                </label>
                            </div>
                            {configuration.agentReviewEnabled && (
                                <div className="bb-toggle-list" style={{ marginTop: '8px' }}>
                                    {configuration.agentBackends.map(backend => (
                                        <div key={backend.id} className={`bb-toggle-row bb-toggle-row--backend${backend.enabled ? ' bb-toggle-row--enabled' : ''}`}>
                                            <input
                                                type="checkbox"
                                                id={`backend-checkbox-${backend.id}`}
                                                checked={backend.enabled}
                                                onChange={event => {
                                                    const enabled = event.currentTarget.checked;
                                                    setConfiguration(prev => ({
                                                        ...prev,
                                                        agentBackends: prev.agentBackends.map(b =>
                                                            b.id === backend.id ? { ...b, enabled } : b
                                                        ),
                                                    }));
                                                    vscode.postMessage({ type: 'updateAgentBackendSelection', backendId: backend.id as AgentBackendId, enabled });
                                                }}
                                                disabled={loading}
                                            />
                                            <label htmlFor={`backend-checkbox-${backend.id}`} className="bb-toggle-main">
                                                <span className="bb-toggle-label bb-toggle-label--with-icon">
                                                    <Icon name={backend.id === 'gemini' ? 'spark' : backend.id === 'codex' ? 'bot' : 'zap'} />
                                                    {backend.label}
                                                </span>
                                                <span className="bb-toggle-detail">{backend.description}</span>
                                            </label>
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
                                                <Icon name={backend.available ? backend.authenticated === false ? 'alert' : 'check' : 'x'} />
                                                {backend.available ? backend.authenticated === false ? 'Needs login' : 'Available' : 'Missing'}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        {error && (
                            <div className="bb-error-wrap">
                                <ErrorCard error={error} onRetry={startScan} />
                            </div>
                        )}

                        {rateLimitWarning && (
                            <div className="bb-rate-limit-banner" style={{
                                padding: '12px',
                                marginBottom: '12px',
                                borderRadius: '8px',
                                background: 'color-mix(in srgb, var(--bb-color-warning) 12%, var(--bb-color-panel))',
                                border: '1px solid var(--bb-color-warning)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                    <Icon name="alert" />
                                    <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--bb-color-warning)' }}>Rate Limit Hit</span>
                                </div>
                                <p style={{ fontSize: '12px', color: 'var(--bb-color-foreground)', margin: '0 0 10px 0' }}>
                                    {rateLimitWarning.message}
                                </p>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button
                                        className="bb-small-button"
                                        onClick={() => {
                                            vscode.postMessage({ type: 'requestScan', target: selectedTargetRef.current });
                                            setRateLimitWarning(null);
                                        }}
                                        disabled={loading}
                                        style={{ fontWeight: 500 }}
                                    >
                                        Continue
                                    </button>
                                    <button
                                        className="bb-small-button"
                                        onClick={() => setRateLimitWarning(null)}
                                        style={{ fontWeight: 500 }}
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        )}

                        {scanIncomplete && !rateLimitWarning && !error && !loading && (
                            <div className="bb-rate-limit-banner" style={{
                                padding: '10px 12px',
                                marginBottom: '12px',
                                borderRadius: '8px',
                                background: 'color-mix(in srgb, var(--bb-color-warning) 10%, var(--bb-color-panel))',
                                border: '1px solid var(--bb-color-warning)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                    <Icon name="alert" />
                                    <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--bb-color-warning)' }}>Scan Incomplete</span>
                                </div>
                                <p style={{ fontSize: '11px', color: 'var(--bb-color-muted)', margin: '0 0 8px 0' }}>
                                    Some agent reviews were interrupted or timed out. Results may be incomplete.
                                </p>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button className="bb-small-button" onClick={startScan} disabled={loading} style={{ fontWeight: 500 }}>
                                        Retry
                                    </button>
                                    <button className="bb-small-button" onClick={() => setScanIncomplete(false)} style={{ fontWeight: 500 }}>
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="bb-start-row">
                            <button className="bb-start-button" onClick={startScan} disabled={loading}>
                                <Icon name={loading ? 'refresh' : 'play'} />
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
                                    {lastScanSpecialists.length === 0 ? (
                                        <div className="bb-empty-state">
                                            <div className="bb-empty-title">No specialist data yet</div>
                                            <div className="bb-empty-copy">Run a scan with Agent Review enabled to see specialist details.</div>
                                        </div>
                                    ) : (() => {
                                        const agentIssues = issues.filter(i => i.sourceType === 'agent-only' || i.sourceType === 'agent-grounded');

                                        return lastScanSpecialists.map((spec, idx) => {
                                            const specName = spec.name;

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
                                                            {spec.backend && (
                                                                <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'var(--bb-color-panel-strong)', color: 'var(--bb-color-muted)' }}>
                                                                    {spec.backend}
                                                                </span>
                                                            )}
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
                                                                Backend: {spec.backend || configuration.agentBackends.find(b => b.enabled)?.label || 'Gemini'}
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

                {activeTab === 'visualizer' && (
                    <main className="bb-view">
                        <Visualizer issues={issues} />
                    </main>
                )}
            </div>
        </ErrorBoundary>
    );
};

export default App;
