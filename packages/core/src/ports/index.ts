/**
 * Port interfaces - contracts for external dependencies.
 * These allow us to swap implementations without changing core logic.
 */

// ============================================================================
// AI Provider Port
// ============================================================================

export interface AIContext {
    /** The code or content to analyze */
    content: string;
    /** File path if applicable */
    filePath?: string;
    /** Programming language */
    language?: string;
    /** Additional context for the AI */
    systemPrompt?: string;
}

export interface AIResponse {
    /** The AI's response text */
    content: string;
    /** Token usage for billing/limits */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    /** Model used */
    model?: string;
}

export interface AIProvider {
    /** Provider name for identification */
    readonly name: string;

    /** Make a completion request */
    complete(prompt: string, context: AIContext): Promise<AIResponse>;

    /** Stream a completion request */
    stream(prompt: string, context: AIContext): AsyncIterable<string>;

    /** Check if provider is available/configured */
    isAvailable(): Promise<boolean>;
}

// ============================================================================
// Security Scanner Port
// ============================================================================

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IssueSourceType = 'deterministic' | 'agent-grounded' | 'agent-only';
export type VerificationStatus = 'verified' | 'unverified' | 'not_applicable';
export type SecurityScanPhase =
    | 'deterministic'
    | 'agent-planner'
    | 'agent-specialists'
    | 'agent-aggregator'
    | 'agent-verification'
    | 'complete'
    | 'degraded'
    | 'skipped';

/** Severity levels ordered from most to least severe */
export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'] as const;

export interface SecurityIssue {
    /** Unique identifier for this issue type */
    ruleId: string;
    /** Human-readable title */
    title: string;
    /** Detailed description */
    description: string;
    /** Severity level */
    severity: Severity;
    /** File where issue was found */
    filePath: string;
    /** Line number (1-indexed) */
    line: number;
    /** Column number (1-indexed) */
    column?: number;
    /** End line for multi-line issues */
    endLine?: number;
    /** The problematic code snippet */
    snippet?: string;
    /** Suggested fix if available */
    suggestedFix?: SecurityFix;
    /** Reference URLs for more info */
    references?: string[];
    /** CWE identifier if applicable */
    cweId?: string;
    /** OWASP category if applicable */
    owaspCategory?: string;
    /** Source scanner or backend */
    source?: string;
    /** Confidence for heuristic or AI-generated findings */
    confidence?: 'high' | 'medium' | 'low';
    /** Normalized source bucket used for UI labeling */
    sourceType?: IssueSourceType;
    /** Whether the finding was grounded in deterministic findings */
    groundedByDeterministicFindings?: boolean;
    /** Verification outcome for agent-generated findings */
    verificationStatus?: VerificationStatus;
    /** Backend used to generate the finding when applicable */
    backend?: string;
    /** Source specialist roles for agent review */
    sourceRoles?: string[];
    /** Related deterministic finding IDs */
    relatedIssueIds?: string[];
    /** Whether the finding came from a degraded fallback path */
    degraded?: boolean;
}

export interface SecurityFix {
    /** Description of what the fix does */
    description: string;
    /** The replacement code */
    replacement: string;
    /** Original code being replaced */
    original?: string;
    /** Whether this fix is safe to auto-apply */
    autoFixable: boolean;
}

export interface ScanResult {
    /** All issues found */
    issues: SecurityIssue[];
    /** Files that were scanned */
    scannedFiles: string[];
    /** Time taken in milliseconds */
    scanDurationMs: number;
    /** Scanner version/info */
    scannerInfo?: string;
}

export interface SecurityScanContext {
    /** Root path for the scan, when known */
    repositoryRoot?: string;
    /** Findings produced by deterministic scanners */
    deterministicIssues?: SecurityIssue[];
    /** Changed files relative to the repository root */
    changedFiles?: string[];
    /** Requested scan paths before internal narrowing */
    requestedPaths?: string[];
    /** Optional status callback for scan progress and degraded-mode messaging */
    reportStatus?: (update: SecurityScanStatusUpdate) => void;
}

export interface SecurityScanStatusUpdate {
    phase: SecurityScanPhase;
    level: 'info' | 'warn' | 'error';
    message: string;
    backend?: string;
    scanner?: string;
    degraded?: boolean;
    /** Dynamic agent names determined by the planner, one per specialist */
    agents?: string[];
    /** Real-time log line from the agent CLI (e.g. opencode progress messages) */
    agentLog?: string;
    /** Error category for rate-limit, auth, network failures */
    errorCategory?: 'auth' | 'rate-limit' | 'network' | 'filesystem' | 'unknown';
    /** Session ID for resuming interrupted CLI agent sessions */
    sessionId?: string | undefined;
}

export interface SecurityScanner {
    /** Scanner name for identification */
    readonly name: string;

    /** Scanner type for orchestration */
    readonly scanKind?: 'deterministic' | 'agent';

    /** Scan a single file */
    scanFile(filePath: string, content: string): Promise<SecurityIssue[]>;

    /** Scan multiple files or a directory */
    scan(paths: string[]): Promise<ScanResult>;

    /** Scan with richer context when orchestration provides it */
    scanWithContext?(paths: string[], context: SecurityScanContext): Promise<ScanResult>;

    /** Check if scanner is available */
    isAvailable(): Promise<boolean>;

    /** Get supported file extensions */
    getSupportedExtensions(): string[];
}

// ============================================================================
// File System Port
// ============================================================================

export interface FileInfo {
    path: string;
    name: string;
    isDirectory: boolean;
    size?: number;
    modifiedAt?: Date;
}

export interface FileSystem {
    /** Read file contents */
    readFile(path: string): Promise<string>;

    /** Write file contents */
    writeFile(path: string, content: string): Promise<void>;

    /** Check if path exists */
    exists(path: string): Promise<boolean>;

    /** List directory contents */
    readDir(path: string): Promise<FileInfo[]>;

    /** Watch for file changes */
    watch(path: string, callback: (event: 'change' | 'delete', path: string) => void): () => void;
}

// ============================================================================
// Logger Port
// ============================================================================

export const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4,
} as const;

export type LogLevel = typeof LOG_LEVELS[keyof typeof LOG_LEVELS];

export interface Logger {
    error(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    debug(message: string, context?: Record<string, unknown>): void;
    verbose(message: string, context?: Record<string, unknown>): void;
}
