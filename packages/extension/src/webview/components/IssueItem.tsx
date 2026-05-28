import React, { useState } from 'react';
import type { IssueData, FixData } from '../messages';
import { vscode } from '../messages';
import { DiffPreview } from './DiffPreview';
import './IssueItem.css';

// ============================================================
// Helpers
// ============================================================

function getSourceChipClass(sourceType?: string): string {
    if (sourceType === 'agent-grounded') return 'source-chip source-chip--grounded';
    if (sourceType === 'agent-only') return 'source-chip source-chip--ai';
    if (sourceType === 'deterministic') return 'source-chip source-chip--det';
    return 'source-chip source-chip--ai';
}

function getSourceChipLabel(sourceType?: string): string | null {
    if (sourceType === 'agent-grounded') return 'deterministic + AI confirmed';
    if (sourceType === 'agent-only') return 'ai review';
    if (sourceType === 'deterministic') return 'deterministic';
    return null;
}

// ============================================================
// Props
// ============================================================

interface IssueItemProps {
    issue: IssueData;
    activeFix: FixData | null;
    explanation: { content: string; loading: boolean; error: string | null; provider: string | null } | null;
    onClearActiveFix: () => void;
    selected?: boolean;
    onSelect?: (issueId: string, selected: boolean) => void;
}

// ============================================================
// Component
// ============================================================

export const IssueItem: React.FC<IssueItemProps> = ({ issue, activeFix, explanation, onClearActiveFix, selected, onSelect }) => {
    const [expanded, setExpanded] = useState(false);

    const handleCardClick = () => {
        if (onSelect) {
            onSelect(issue.id, !selected);
        } else {
            vscode.postMessage({
                type: 'navigateToIssue',
                filePath: issue.filePath,
                line: issue.line,
                column: issue.column,
            });
        }
    };

    const handleChevronClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded(prev => !prev);
    };

    const handleExplain = (e: React.MouseEvent) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'explainIssue', issue });
    };

    const handleSuggestFix = (e: React.MouseEvent) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'suggestFix', issue });
    };

    const handleApplyFix = () => {
        if (!activeFix) return;
        vscode.postMessage({ type: 'applyFix', issue, fix: activeFix });
    };

    const fileName = issue.filePath.split('/').pop() || issue.filePath;
    const sourceChipLabel = getSourceChipLabel(issue.sourceType);
    const sourceChipClass = getSourceChipClass(issue.sourceType);

    const severityStyle = {
        '--severity-color': `var(--bb-severity-${issue.severity})`,
        '--severity-bg': `var(--bb-severity-${issue.severity}-bg)`,
    } as React.CSSProperties;

    const evidenceText = issue.snippet || issue.description || '';

    if (activeFix) {
        return (
            <div className="issue-item issue-item--fixing" style={severityStyle}>
                <DiffPreview
                    title={`Fix: ${issue.title}`}
                    description={activeFix.description}
                    filePath={issue.filePath}
                    line={issue.line}
                    original={activeFix.original || issue.snippet || ''}
                    replacement={activeFix.replacement}
                    autoFixable={activeFix.autoFixable}
                    onApply={handleApplyFix}
                    onCancel={onClearActiveFix}
                />
            </div>
        );
    }

    return (
        <div
            className={`issue-item${selected ? ' issue-item--selected' : ''}`}
            onClick={handleCardClick}
            style={severityStyle}
        >
            {/* ── Top row: selection checkbox + severity + source chip + chevron ── */}
            <div className="issue-item-header">
                {onSelect && (
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => {
                            e.stopPropagation();
                            onSelect(issue.id, e.target.checked);
                        }}
                        className="issue-checkbox"
                    />
                )}
                <span className="severity-badge">{issue.severity}</span>
                {sourceChipLabel && (
                    <span className={sourceChipClass}>{sourceChipLabel}</span>
                )}
                {/* Chevron */}
                <button
                    className={`issue-chevron${expanded ? ' issue-chevron--open' : ''}`}
                    onClick={handleChevronClick}
                    title={expanded ? 'Collapse evidence' : 'Expand evidence'}
                    aria-expanded={expanded}
                >
                    ›
                </button>
            </div>

            {/* ── Title ── */}
            <div className="issue-title">{issue.title}</div>

            {/* ── Description ── */}
            <div className="issue-description">{issue.description}</div>

            {/* ── Location ── */}
            <div className="issue-location">
                <span className="issue-location__pin">📍</span>
                <span>{fileName}:{issue.line}</span>
            </div>

            {/* ── Actions ── */}
            <div className="issue-actions" onClick={e => e.stopPropagation()}>
                <button
                    className="action-button action-explain"
                    onClick={handleExplain}
                    title="Explain this issue with AI"
                >
                    Explain
                </button>
                <button
                    className="action-button action-fix"
                    onClick={handleSuggestFix}
                    title="Get AI-suggested fix"
                >
                    Suggest Fix
                </button>
            </div>

            {/* ── Expandable evidence ── */}
            {expanded && (
                <div className="issue-evidence" onClick={e => e.stopPropagation()}>
                    <div className="issue-evidence__label">
                        <span className="issue-evidence__icon">🔬</span>
                        Evidence
                    </div>
                    <div className="issue-evidence__text">{evidenceText}</div>
                    {issue.snippet && (
                        <pre className="issue-evidence__code">{issue.snippet}</pre>
                    )}
                </div>
            )}

            {/* ── AI Explanation panel (when triggered separately) ── */}
            {(explanation?.loading || explanation?.content || explanation?.error) && (
                <div className="issue-explanation" onClick={e => e.stopPropagation()}>
                    <div className="issue-explanation__header">
                        <span>AI Explanation</span>
                        {explanation?.provider && (
                            <span className="issue-explanation__provider">{explanation.provider}</span>
                        )}
                    </div>
                    {explanation?.loading && (
                        <div className="issue-explanation__status">Generating explanation...</div>
                    )}
                    {explanation?.error && (
                        <div className="issue-explanation__error">{explanation.error}</div>
                    )}
                    {explanation?.content && (
                        <div className="issue-explanation__content">{explanation.content}</div>
                    )}
                </div>
            )}
        </div>
    );
};
