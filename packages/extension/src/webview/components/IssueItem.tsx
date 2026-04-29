import React from 'react';
import type { IssueData, FixData } from '../messages';
import { vscode } from '../messages';
import { DiffPreview } from './DiffPreview';
import './IssueItem.css';

interface IssueItemProps {
    issue: IssueData;
    activeFix: FixData | null;
    explanation: { content: string; loading: boolean; error: string | null; provider: string | null } | null;
    onClearActiveFix: () => void;
}

export const IssueItem: React.FC<IssueItemProps> = ({ issue, activeFix, explanation, onClearActiveFix }) => {
    const handleClick = () => {
        vscode.postMessage({
            type: 'navigateToIssue',
            filePath: issue.filePath,
            line: issue.line,
            column: issue.column,
        });
    };

    const handleExplain = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent triggering navigation
        vscode.postMessage({
            type: 'explainIssue',
            issue: issue,
        });
    };

    const handleSuggestFix = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent triggering navigation
        vscode.postMessage({
            type: 'suggestFix',
            issue: issue,
        });
    };

    const fileName = issue.filePath.split('/').pop() || issue.filePath;
    const sourceTypeLabel = issue.sourceType === 'agent-grounded'
        ? 'ai grounded'
        : issue.sourceType === 'agent-only'
            ? 'ai review'
            : issue.sourceType === 'deterministic'
                ? 'deterministic'
                : null;

    // Dynamic severity colors using CSS variables
    const severityStyle = {
        '--severity-color': `var(--bb-severity-${issue.severity})`,
        '--severity-bg': `var(--bb-severity-${issue.severity}-bg)`,
    } as React.CSSProperties;

    const handleApplyFix = () => {
        if (!activeFix) return;
        vscode.postMessage({
            type: 'applyFix',
            issue: issue,
            fix: activeFix
        });
    };

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
            className="issue-item"
            onClick={handleClick}
            style={severityStyle}
        >
            {/* Header: Severity + Title */}
            <div className="issue-item-header">
                <span className="severity-badge">
                    {issue.severity}
                </span>
                <span className="issue-title">
                    {issue.title}
                </span>
            </div>

            {/* Description */}
            <div className="issue-description">
                {issue.description}
            </div>

            {/* Location */}
            <div className="issue-location">
                <span>{fileName}:{issue.line}</span>
            </div>

            {(issue.source || issue.confidence || issue.verificationStatus || issue.backend || issue.degraded || sourceTypeLabel) && (
                <div className="issue-meta">
                    {sourceTypeLabel && (
                        <span className={`issue-meta__badge issue-meta__badge--${issue.sourceType}`}>
                            {sourceTypeLabel}
                        </span>
                    )}
                    {issue.source && <span className="issue-meta__badge">{issue.source}</span>}
                    {issue.confidence && <span className="issue-meta__badge">confidence: {issue.confidence}</span>}
                    {issue.verificationStatus && issue.verificationStatus !== 'not_applicable' && (
                        <span className="issue-meta__badge">verification: {issue.verificationStatus}</span>
                    )}
                    {issue.backend && <span className="issue-meta__badge">backend: {issue.backend}</span>}
                    {issue.degraded && <span className="issue-meta__badge">degraded</span>}
                </div>
            )}

            {/* Snippet (if available) */}
            {issue.snippet && (
                <pre className="issue-snippet">
                    {issue.snippet}
                </pre>
            )}

            {/* AI Actions */}
            <div className="issue-actions">
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

            {(explanation?.loading || explanation?.content || explanation?.error) && (
                <div className="issue-explanation" onClick={(e) => e.stopPropagation()}>
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
