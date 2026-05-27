import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { IssueData, FixData } from '../messages';
import { IssueItem } from './IssueItem';
import './IssueList.css';

// ============================================================
// Types & Constants
// ============================================================

interface IssueListProps {
    issues: IssueData[];
    loading?: boolean;
    activeFix: { issueId: string; fix: FixData } | null;
    explanations: Record<string, { content: string; loading: boolean; error: string | null; provider: string | null }>;
    onClearActiveFix: () => void;
    scanStatus?: { phase: string; message: string; backend?: string; scanner?: string; level: string } | null;
    batchProgress?: { current: number; total: number } | null;
    scanDepthLabel?: string;
    agentLogs?: string[];
}

type SortMethod = 'severity' | 'filename';
type FilterMethod = 'all' | 'ai' | 'deterministic';

const severityRank: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

// 4 primary phases (maps phase string → dot index 0-3)
const PHASE_DOT_MAP: Record<string, number> = {
    'deterministic': 0,
    'agent-planner': 1,
    'agent-specialists': 2,
    'agent-aggregator': 3,
    'agent-verification': 3,
    'complete': 4,
};

const PHASE_LABEL_MAP: Record<string, string> = {
    'deterministic':      'Running deterministic scanners...',
    'agent-planner':      'AI Planner creating specialists...',
    'agent-specialists':  'Specialist agents reviewing code...',
    'agent-aggregator':   'Aggregating and deduplicating findings...',
    'agent-verification': 'Verifying findings...',
    'skipped':            'AI review skipped',
    'degraded':           'Scan completed with warnings',
    'complete':           'Scan complete',
};

const PHASE_PROGRESS: Record<string, number> = {
    'deterministic': 25,
    'agent-planner': 50,
    'agent-specialists': 75,
    'agent-aggregator': 90,
    'agent-verification': 95,
    'complete': 100,
};

const DOT_LABELS = ['Deterministic', 'Planner', 'Specialists', 'Aggregator'];

// Severity colors for risk bar segments
const SEVERITY_COLORS: Record<string, string> = {
    critical: '#E24B4A',
    high:     '#EF9F27',
    medium:   '#FAC775',
    low:      '#378ADD',
};

// ============================================================
// ScanProgressSection
// ============================================================

const ScanProgressSection: React.FC<{
    scanStatus: { phase: string; message: string; backend?: string; scanner?: string } | null;
    batchProgress: { current: number; total: number } | null;
    agentLogs?: string[];
}> = ({ scanStatus, batchProgress, agentLogs }) => {
    if (!scanStatus && !batchProgress) {
        // Graceful fallback — no scanStatus messages arrived yet
        return (
            <div className="scan-progress scan-progress--fallback">
                <div className="scan-progress__spinner">
                    <vscode-progress-ring />
                </div>
                <div className="scan-progress__pending-msg">
                    Findings will appear here as scanners complete...
                </div>
            </div>
        );
    }

    const phase = scanStatus?.phase ?? 'deterministic';
    const phaseLabel = PHASE_LABEL_MAP[phase] ?? scanStatus?.message ?? 'Scanning...';
    const currentDot = PHASE_DOT_MAP[phase] ?? 0;
    const progressPct = batchProgress
        ? Math.round((batchProgress.current / batchProgress.total) * 100)
        : PHASE_PROGRESS[phase] ?? 10;

    // Sub-label
    let subLabel = scanStatus?.scanner ?? scanStatus?.backend ?? '';
    if (batchProgress) {
        subLabel = `agent ${batchProgress.current} of ${batchProgress.total}`;
        if (scanStatus?.backend) subLabel = `${scanStatus.backend} · ${subLabel}`;
    }

    return (
        <div className="scan-progress">
            {/* Phase label */}
            <div className="scan-progress__phase-label">{phaseLabel}</div>

            {/* Sub label */}
            {subLabel && (
                <div className="scan-progress__sub-label">{subLabel}</div>
            )}

            {/* Progress bar */}
            <div className="scan-progress__track">
                <div
                    className="scan-progress__bar"
                    style={{ width: `${progressPct}%` }}
                    role="progressbar"
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                />
            </div>

            {/* Phase dots */}
            <div className="scan-progress__dots">
                {DOT_LABELS.map((_, i) => {
                    const state = i < currentDot ? 'done' : i === currentDot ? 'active' : 'future';
                    return (
                        <div
                            key={i}
                            className={`scan-progress__dot scan-progress__dot--${state}`}
                        />
                    );
                })}
            </div>

            {/* Phase label row */}
            <div className="scan-progress__dot-labels">
                {DOT_LABELS.map((label, i) => (
                    <span
                        key={i}
                        className={`scan-progress__dot-label${i === currentDot ? ' scan-progress__dot-label--active' : ''}`}
                    >
                        {label}
                    </span>
                ))}
            </div>

            {/* Pending message */}
            <div className="scan-progress__pending-msg">
                Findings will appear here as scanners complete...
            </div>
            {agentLogs && agentLogs.length > 0 && (
                <AgentLogDisplay logs={agentLogs} />
            )}
        </div>
    );
};

const AgentLogDisplay: React.FC<{ logs: string[] }> = ({ logs }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [logs]);

    return (
        <div className="scan-progress__agent-log" style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
                Activity log — {logs.length} lines
            </div>
            <div
                ref={containerRef}
                className="scan-progress__agent-log-content"
                style={{
                    maxHeight: '160px',
                    overflowY: 'auto',
                    fontSize: '11px',
                    lineHeight: '1.5',
                    fontFamily: 'var(--bb-font-mono, "Cascadia Code", "Fira Code", monospace)',
                    color: 'var(--vscode-editor-foreground, #ccc)',
                    background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    border: '0.5px solid var(--vscode-widget-border, rgba(128,128,128,0.2))',
                }}
            >
                {logs.map((line, i) => (
                    <div key={i}>{line}</div>
                ))}
            </div>
        </div>
    );
};

// ============================================================
// SummaryBar
// ============================================================

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

const SummaryBar: React.FC<{ counts: Record<string, number> }> = ({ counts }) => {
    const total = SEVERITY_ORDER.reduce((s, k) => s + (counts[k] || 0), 0);

    return (
        <div className="summary-bar">
            {/* Badge pills */}
            <div className="summary-bar__badges">
                {SEVERITY_ORDER.map(sev => {
                    const n = counts[sev] || 0;
                    if (n === 0) return null;
                    return (
                        <span key={sev} className={`summary-badge summary-badge--${sev}`}>
                            {n} {sev}
                        </span>
                    );
                })}
            </div>

            {/* Risk bar */}
            {total > 0 && (
                <div className="risk-bar">
                    {SEVERITY_ORDER.map(sev => {
                        const n = counts[sev] || 0;
                        if (n === 0) return null;
                        return (
                            <div
                                key={sev}
                                className="risk-bar__segment"
                                style={{
                                    flex: n,
                                    backgroundColor: SEVERITY_COLORS[sev],
                                }}
                                title={`${n} ${sev}`}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// ============================================================
// IssueList
// ============================================================

export const IssueList: React.FC<IssueListProps> = ({
    issues, loading, activeFix, explanations, onClearActiveFix, scanStatus, batchProgress, agentLogs,
}) => {
    const [sortMethod, setSortMethod] = useState<SortMethod>('severity');
    const [filterMethod, setFilterMethod] = useState<FilterMethod>('all');

    // Severity counts for summary bar
    const counts = useMemo(() =>
        issues.reduce((acc, issue) => {
            acc[issue.severity] = (acc[issue.severity] || 0) + 1;
            return acc;
        }, {} as Record<string, number>),
    [issues]);

    const sortedAndGroupedIssues = useMemo(() => {
        // 1. Filter
        const filtered = issues.filter(issue => {
            if (filterMethod === 'ai') {
                return issue.sourceType === 'agent-only' || issue.sourceType === 'agent-grounded';
            }
            if (filterMethod === 'deterministic') {
                return issue.sourceType === 'deterministic';
            }
            return true;
        });

        // 2. Sort
        const sorted = [...filtered].sort((a, b) => {
            if (sortMethod === 'severity') {
                const ra = severityRank[a.severity] ?? 99;
                const rb = severityRank[b.severity] ?? 99;
                if (ra !== rb) return ra - rb;
                return a.filePath.localeCompare(b.filePath);
            } else {
                const fa = a.filePath.split('/').pop() || '';
                const fb = b.filePath.split('/').pop() || '';
                if (fa !== fb) return fa.localeCompare(fb);
                return (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
            }
        });

        // 3. Group by file
        const groups: { filePath: string; issues: IssueData[] }[] = [];
        const groupMap = new Map<string, IssueData[]>();
        sorted.forEach(issue => {
            if (!groupMap.has(issue.filePath)) {
                const grp: IssueData[] = [];
                groupMap.set(issue.filePath, grp);
                groups.push({ filePath: issue.filePath, issues: grp });
            }
            groupMap.get(issue.filePath)!.push(issue);
        });

        return groups;
    }, [issues, sortMethod, filterMethod]);

    // While loading — show progress section
    if (loading) {
        return (
            <div>
                <ScanProgressSection
                    scanStatus={scanStatus ?? null}
                    batchProgress={batchProgress ?? null}
                    agentLogs={agentLogs ?? []}
                />
                {/* Show any issues that have already streamed in */}
                {issues.length > 0 && (
                    <>
                        <SummaryBar counts={counts} />
                        {sortedAndGroupedIssues.map(({ filePath, issues: fileIssues }) => {
                            const fileName = filePath.split('/').pop() || filePath;
                            return (
                                <div key={filePath} className="file-group">
                                    <div className="file-header">
                                        <span title={filePath}>{fileName}</span>
                                        <span className="file-badge">{fileIssues.length}</span>
                                    </div>
                                    {fileIssues.map(issue => (
                                        <IssueItem
                                            key={issue.id}
                                            issue={issue}
                                            activeFix={activeFix?.issueId === issue.id ? activeFix.fix : null}
                                            explanation={explanations[issue.id] ?? null}
                                            onClearActiveFix={onClearActiveFix}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </>
                )}
            </div>
        );
    }

    if (issues.length === 0) {
        return (
            <div className="issue-list-empty">
                <div className="issue-list-empty-title">Ready To Scan</div>
                <div>No issues loaded yet</div>
                <div className="issue-list-empty-subtitle">
                    Run a file or workspace scan to populate results.
                </div>
            </div>
        );
    }

    return (
        <div className="issue-list">
            {/* Summary Bar */}
            <SummaryBar counts={counts} />

            {/* Controls Row */}
            <div className="issue-list-controls">
                <label htmlFor="sort-select">Sort</label>
                <select
                    id="sort-select"
                    className="issue-list-select"
                    value={sortMethod}
                    onChange={e => setSortMethod(e.target.value as SortMethod)}
                >
                    <option value="severity">Severity ▾</option>
                    <option value="filename">File name ▾</option>
                </select>

                <label htmlFor="filter-select">Filter</label>
                <select
                    id="filter-select"
                    className="issue-list-select"
                    value={filterMethod}
                    onChange={e => setFilterMethod(e.target.value as FilterMethod)}
                >
                    <option value="all">All ▾</option>
                    <option value="ai">AI only</option>
                    <option value="deterministic">Deterministic</option>
                </select>
            </div>

            {/* File groups */}
            {sortedAndGroupedIssues.map(({ filePath, issues: fileIssues }) => {
                const fileName = filePath.split('/').pop() || filePath;
                return (
                    <div key={filePath} className="file-group">
                        <div className="file-header">
                            <span title={filePath}>{fileName}</span>
                            <span className="file-badge">{fileIssues.length}</span>
                        </div>
                        {fileIssues.map(issue => (
                            <IssueItem
                                key={issue.id}
                                issue={issue}
                                activeFix={activeFix?.issueId === issue.id ? activeFix.fix : null}
                                explanation={explanations[issue.id] ?? null}
                                onClearActiveFix={onClearActiveFix}
                            />
                        ))}
                    </div>
                );
            })}
        </div>
    );
};
