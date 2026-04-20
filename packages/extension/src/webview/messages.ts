import type { CodeIssue, IssueSeverity } from '@backbrain/core';

/**
 * Acquire the VS Code API for webview → extension communication.
 * We use a singleton pattern to ensure it's only acquired once, 
 * which prevents errors during hot-reloads or multiple imports.
 */
let vscodeApi: ReturnType<typeof acquireVsCodeApi> | undefined;

declare function acquireVsCodeApi(): {
    postMessage(message: WebviewMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
};

export function getVsCodeApi() {
    if (!vscodeApi) {
        if (typeof acquireVsCodeApi === 'function') {
            vscodeApi = acquireVsCodeApi();
        } else {
            // Fallback for development/testing outside of VS Code
            console.warn('acquireVsCodeApi is not available. Using mock API.');
            vscodeApi = {
                postMessage: (msg: WebviewMessage) => console.log('Mock PostMessage:', msg),
                getState: () => ({}),
                setState: (state: unknown) => console.log('Mock SetState:', state),
            };
        }
    }
    return vscodeApi;
}

export const vscode = getVsCodeApi();

// ============================================================================
// Webview → Extension Messages
// ============================================================================

export type WebviewMessage =
    | { type: 'requestScan' }
    | { type: 'requestScanFile' }
    | { type: 'navigateToIssue'; filePath: string; line: number; column?: number }
    | { type: 'ready' }
    | { type: 'explainIssue'; issue: IssueData }
    | { type: 'suggestFix'; issue: IssueData }
    // Phase 10: Fix messages
    | { type: 'applyFix'; issue: IssueData; fix: FixData }
    | { type: 'revertFix'; sessionId: string }
    | { type: 'batchFix' }
    | { type: 'requestFixHistory' }
    | { type: 'exportReport' };

// ============================================================================
// Extension → Webview Messages
// ============================================================================

export type ExtensionMessage =
    | { type: 'scanStarted' }
    | { type: 'scanComplete'; issues: IssueData[] }
    | { type: 'scanError'; error: string }
    | { type: 'statusUpdate'; level: 'info' | 'warn' | 'error'; message: string }
    | { type: 'statusClear' }
    | { type: 'issuesUpdated'; issues: IssueData[]; batchInfo?: { current: number; total: number } }
    | { type: 'explanationStarted'; issueId: string; provider?: string | null }
    | { type: 'explanationChunk'; issueId: string; chunk: string }
    | { type: 'explanationComplete'; issueId: string; content: string; provider?: string | null }
    | { type: 'explanationError'; issueId: string; error: string; provider?: string | null }
    // Phase 10: Fix messages
    | { type: 'fixApplied'; sessionId: string; summary: FixSummaryData }
    | { type: 'fixReverted'; sessionId: string }
    | { type: 'fixHistory'; sessions: FixSessionData[] }
    | { type: 'fixError'; error: string }
    | { type: 'fixSuggested'; issueId: string; fix: FixData };

// ============================================================================
// Fix Data Types
// ============================================================================

export interface FixData {
    description: string;
    replacement: string;
    original?: string;
    autoFixable: boolean;
}

export interface FixSummaryData {
    totalIssues: number;
    fixed: number;
    skipped: number;
    failed: number;
}

export interface FixSessionData {
    sessionId: string;
    timestamp: number;
    fixed: number;
    failed: number;
    files: string[];
    reverted: boolean;
}

// ============================================================================
// Issue Data (simplified for UI)
// ============================================================================

export interface IssueData {
    id: string;
    title: string;
    description: string;
    severity: IssueSeverity;
    filePath: string;
    line: number;
    column: number; // Normalized to always be a number
    snippet?: string;
    category: string;
    source?: string;
    confidence?: 'high' | 'medium' | 'low';
    sourceType?: 'deterministic' | 'agent';
}

/**
 * Convert CodeIssue from core to IssueData for the webview.
 * This function normalizes the data to ensure the UI always has 
 * the expected fields, even if the core library changes.
 */
export function toIssueData(issue: CodeIssue): IssueData {
    const { location } = issue;

    const issueData: IssueData = {
        id: issue.id || 'unknown',
        title: issue.title || 'Untitled Issue',
        description: issue.description || '',
        severity: issue.severity || 'info',
        filePath: location?.filePath || 'unknown',
        // Normalize line and column to be 1-indexed numbers
        line: Math.max(1, location?.line || 1),
        column: Math.max(1, location?.column || 1),
        category: issue.category || 'logic',
        // Note: snippet is not currently provided by the core CodeIssue type
        // but is reserved here for future implementation.
    };

    if (issue.source !== undefined) {
        issueData.source = issue.source;
        issueData.sourceType = issue.source.startsWith('agent-review:') ? 'agent' : 'deterministic';
    }
    if (issue.confidence !== undefined) {
        issueData.confidence = issue.confidence;
    }

    return issueData;
}
