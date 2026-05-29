import type { CodeIssue, IssueSeverity, SecurityScanPhase, FileGraph, WorkflowGraph } from '@backbrain/core';
export type { FileGraph, FileNode, FileEdge, WorkflowGraph, WorkflowStep, WorkflowConnection } from '@backbrain/core';

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
    | { type: 'requestScan'; target?: ScanTarget }
    | { type: 'requestScanFile' }
    | { type: 'refreshConfiguration' }
    | { type: 'selectCustomPaths' }
    | { type: 'checkChangedFiles' }
    | { type: 'updateScannerSelection'; scannerId: string; enabled: boolean }
    | { type: 'updateAgentReviewEnabled'; enabled: boolean }
    | { type: 'updateAgentBackendSelection'; backendId: AgentBackendId; enabled: boolean }
    | { type: 'updateAgentPreferredBackend'; backendId: AgentBackendId }
    | { type: 'updateScanDepth'; depth: AgentScanDepth }
    | { type: 'navigateToIssue'; filePath: string; line: number; column?: number }
    | { type: 'ready' }
    | { type: 'explainIssue'; issue: IssueData }
    | { type: 'suggestFix'; issue: IssueData }
    // Phase 10: Fix messages
    | { type: 'applyFix'; issue: IssueData; fix: FixData }
    | { type: 'revertFix'; sessionId: string }
    | { type: 'batchFix' }
    | { type: 'requestFixHistory' }
    | { type: 'exportReport' }
    | { type: 'setDebugMode'; enabled: boolean }
    | { type: 'requestGraphData'; paths?: string[] }
    | { type: 'openVisualizerTab' };

// ============================================================================
// Extension → Webview Messages
// ============================================================================

export type ExtensionMessage =
    | { type: 'scanStarted' }
    | { type: 'scanComplete'; issues: IssueData[] }
    | { type: 'scanError'; error: string }
    | { type: 'statusUpdate'; level: 'info' | 'warn' | 'error'; message: string }
    | { type: 'scanStatus'; phase: SecurityScanPhase; level: 'info' | 'warn' | 'error'; message: string; backend?: string; scanner?: string; degraded?: boolean; agents?: string[]; agentLog?: string }
    | { type: 'statusClear' }
    | { type: 'configurationState'; state: ConfigurationState }
    | { type: 'issuesUpdated'; issues: IssueData[]; batchInfo?: { current: number; total: number } }
    | { type: 'setScanDepthTier'; label: string }
    | { type: 'customPathsSelected'; displayNames: string[] }
    | { type: 'changedFilesStatus'; count?: number; error?: string }
    | { type: 'explanationStarted'; issueId: string; provider?: string | null }
    | { type: 'explanationChunk'; issueId: string; chunk: string }
    | { type: 'explanationComplete'; issueId: string; content: string; provider?: string | null }
    | { type: 'explanationError'; issueId: string; error: string; provider?: string | null }
    // Phase 10: Fix messages
    | { type: 'fixApplied'; sessionId: string; summary: FixSummaryData; issueId?: string }
    | { type: 'fixReverted'; sessionId: string }
    | { type: 'fixHistory'; sessions: FixSessionData[] }
    | { type: 'fixError'; error: string }
    | { type: 'fixSuggested'; issueId: string; fix: FixData }
    | { type: 'debugStatus'; steps: DebugStep[]; paused: boolean; phase: string }
    | { type: 'graphData'; fileGraph: FileGraph; workflowGraph: WorkflowGraph; status: 'ready' | 'loading' | 'error'; issues?: IssueData[] };

// ============================================================================
// Configuration Data
// ============================================================================

export type ScanTarget = 'file' | 'workspace' | 'changed' | 'custom';
export type AgentBackendId = 'codex' | 'gemini' | 'opencode' | 'groq';
export type AgentScanDepth = 'developer' | 'team' | 'security' | 'audit';

export interface ScannerState {
    id: string;
    label: string;
    enabled: boolean;
    available: boolean;
    description: string;
}

export interface AgentBackendState {
    id: AgentBackendId;
    label: string;
    enabled: boolean;
    available: boolean;
    authenticated?: boolean;
    preferred: boolean;
    description: string;
}

export interface ConfigurationState {
    scanners: ScannerState[];
    agentBackends: AgentBackendState[];
    agentReviewEnabled: boolean;
    scanDepth: AgentScanDepth;
    scanDepthLabel: string;
    /** Display name of the active AI provider (e.g. "OpenAI gpt-4o") */
    activeProvider?: string;
}

// ============================================================================
// Debug Mode Types
// ============================================================================

export type DebugStepStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'unavailable' | 'working' | 'skipped';

export interface DebugStep {
    id: string;
    label: string;
    status: DebugStepStatus;
    message?: string;
    duration?: number;
}

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
    sourceType?: 'deterministic' | 'agent-grounded' | 'agent-only';
    verificationStatus?: 'verified' | 'unverified' | 'not_applicable';
    groundedByDeterministicFindings?: boolean;
    backend?: string;
    sourceRoles?: string[];
    relatedIssueIds?: string[];
    degraded?: boolean;
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
    }
    if (issue.sourceType !== undefined) {
        issueData.sourceType = issue.sourceType;
    } else if (issue.source !== undefined) {
        issueData.sourceType = issue.source.startsWith('agent-review:') ? 'agent-only' : 'deterministic';
    }
    if (issue.confidence !== undefined) {
        issueData.confidence = issue.confidence;
    }
    if (issue.verificationStatus !== undefined) {
        issueData.verificationStatus = issue.verificationStatus;
    }
    if (issue.groundedByDeterministicFindings !== undefined) {
        issueData.groundedByDeterministicFindings = issue.groundedByDeterministicFindings;
    }
    if (issue.backend !== undefined) {
        issueData.backend = issue.backend;
    }
    if (issue.sourceRoles !== undefined) {
        issueData.sourceRoles = issue.sourceRoles;
    }
    if (issue.relatedIssueIds !== undefined) {
        issueData.relatedIssueIds = issue.relatedIssueIds;
    }
    if (issue.degraded !== undefined) {
        issueData.degraded = issue.degraded;
    }

    return issueData;
}
