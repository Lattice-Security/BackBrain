import React, { useState, useMemo } from 'react';
import type { IssueData, FixData } from '../messages';
import { IssueItem } from './IssueItem';
import './IssueList.css';

interface IssueListProps {
    issues: IssueData[];
    loading?: boolean;
    activeFix: { issueId: string; fix: FixData } | null;
    explanations: Record<string, { content: string; loading: boolean; error: string | null; provider: string | null }>;
    onClearActiveFix: () => void;
    scanStatus?: { phase: string; message: string; backend?: string; scanner?: string; level: string } | null;
    batchProgress?: { current: number; total: number } | null;
}

type SortMethod = 'severity' | 'filename';

const severityRank: Record<string, number> = {
    'critical': 0,
    'high': 1,
    'medium': 2,
    'low': 3,
    'info': 4,
};

const SCAN_PHASES = [
    'deterministic',
    'agent-planner',
    'agent-specialists',
    'agent-aggregator',
    'agent-verification',
    'complete',
];

const PHASE_LABELS: Record<string, string> = {
    'deterministic':      'Running deterministic scanners...',
    'agent-planner':      'AI Planner creating specialists...',
    'agent-specialists':  'Specialist agents reviewing code...',
    'agent-aggregator':   'Aggregating findings...',
    'agent-verification': 'Verifying findings...',
    'skipped':            'AI review skipped',
    'degraded':           'Scan completed with warnings',
    'complete':           'Scan complete',
};

function getPhaseProgress(phase: string): number {
    const idx = SCAN_PHASES.indexOf(phase);
    if (idx === -1) return 10; // unknown phase — show minimal progress
    return Math.round(((idx + 1) / SCAN_PHASES.length) * 100);
}

const ScanProgressBar: React.FC<{
    scanStatus: { phase: string; message: string; backend?: string; scanner?: string } | null;
    batchProgress: { current: number; total: number } | null;
}> = ({ scanStatus, batchProgress }) => {
    if (!scanStatus && !batchProgress) {
        // Fallback: simple indeterminate state
        return (
            <div className="issue-list-loading">
                <vscode-progress-ring />
                <div className="issue-list-loading-text">Scanning...</div>
            </div>
        );
    }

    const phase = scanStatus?.phase ?? 'deterministic';
    const phaseLabel = PHASE_LABELS[phase] ?? scanStatus?.message ?? 'Scanning...';
    const subLabel = scanStatus?.scanner ?? scanStatus?.backend ?? null;
    const progress = batchProgress
        ? Math.round((batchProgress.current / batchProgress.total) * 100)
        : getPhaseProgress(phase);

    return (
        <div className="scan-progress">
            <div className="scan-progress__phase-label">{phaseLabel}</div>
            <div className="scan-progress__track">
                <div
                    className="scan-progress__bar"
                    style={{ width: `${progress}%` }}
                    role="progressbar"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                />
            </div>
            <div className="scan-progress__sub">
                {batchProgress
                    ? `${batchProgress.current} / ${batchProgress.total} files`
                    : subLabel ?? ''}
            </div>
        </div>
    );
};

export const IssueList: React.FC<IssueListProps> = ({
    issues, loading, activeFix, explanations, onClearActiveFix, scanStatus, batchProgress
}) => {
    const [sortMethod, setSortMethod] = useState<SortMethod>('severity');

    const sortedAndGroupedIssues = useMemo(() => {
        // 1. Sort the raw issues first
        const sortedIssues = [...issues].sort((a, b) => {
            if (sortMethod === 'severity') {
                const rankA = severityRank[a.severity] ?? 99;
                const rankB = severityRank[b.severity] ?? 99;
                if (rankA !== rankB) return rankA - rankB;
                // Fallback to filename if severity is same
                return a.filePath.localeCompare(b.filePath);
            } else {
                // Filename sorting
                const fileA = a.filePath.split('/').pop() || '';
                const fileB = b.filePath.split('/').pop() || '';
                if (fileA !== fileB) return fileA.localeCompare(fileB);
                // Fallback to severity if filename is same
                return (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
            }
        });

        // 2. Group them by file while preserving the sorted order of files
        const groups: { filePath: string; issues: IssueData[] }[] = [];
        const groupMap = new Map<string, IssueData[]>();

        sortedIssues.forEach(issue => {
            if (!groupMap.has(issue.filePath)) {
                const newGroup: IssueData[] = [];
                groupMap.set(issue.filePath, newGroup);
                groups.push({ filePath: issue.filePath, issues: newGroup });
            }
            groupMap.get(issue.filePath)!.push(issue);
        });

        return groups;
    }, [issues, sortMethod]);

    if (loading) {
        return (
            <ScanProgressBar
                scanStatus={scanStatus ?? null}
                batchProgress={batchProgress ?? null}
            />
        );
    }

    if (issues.length === 0) {
        return (
            <div className="issue-list-empty">
                <div className="issue-list-empty-title">
                    Ready To Scan
                </div>
                <div>No issues loaded yet</div>
                <div className="issue-list-empty-subtitle">
                    Run a file or workspace scan to populate results.
                </div>
            </div>
        );
    }

    return (
        <div className="issue-list">
            <div className="issue-list-controls">
                <label htmlFor="sort-select">Sort by:</label>
                <select
                    id="sort-select"
                    className="issue-list-sort-select"
                    value={sortMethod}
                    onChange={(e) => setSortMethod(e.target.value as SortMethod)}
                >
                    <option value="severity">Severity</option>
                    <option value="filename">File Name</option>
                </select>
            </div>

            {sortedAndGroupedIssues.map(({ filePath, issues: fileIssues }) => {
                const fileName = filePath.split('/').pop() || filePath;
                return (
                    <div key={filePath} className="file-group">
                        {/* File Header */}
                        <div className="file-header">
                            <span title={filePath}>{fileName}</span>
                            <span className="file-badge">
                                {fileIssues.length}
                            </span>
                        </div>

                        {/* Issues for this file */}
                        {fileIssues.map((issue) => (
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
