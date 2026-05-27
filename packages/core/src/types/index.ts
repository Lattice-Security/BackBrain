/**
 * Core domain types for BackBrain
 */

// ============================================================================
// Code Analysis Types
// ============================================================================

export interface CodeLocation {
    filePath: string;
    line: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
}

export interface CodeIssue {
    id: string;
    ruleId?: string;
    type: CodeIssueType;
    title: string;
    description: string;
    location: CodeLocation;
    severity: IssueSeverity;
    suggestedFix?: CodeFix;
    category: IssueCategory;
    source?: string;
    confidence?: 'high' | 'medium' | 'low';
    sourceType?: 'deterministic' | 'agent-grounded' | 'agent-only';
    groundedByDeterministicFindings?: boolean;
    verificationStatus?: 'verified' | 'unverified' | 'not_applicable';
    backend?: string;
    sourceRoles?: string[];
    relatedIssueIds?: string[];
    degraded?: boolean;
}

export type CodeIssueType =
    | 'name_mismatch'
    | 'flow_gap'
    | 'deprecated_api'
    | 'missing_dependency'
    | 'style_inconsistency'
    | 'logic_error'
    | 'integration_mismatch'
    | 'api_contract_violation'
    | 'security_vulnerability';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type IssueCategory = 'security' | 'quality' | 'style' | 'dependency' | 'logic';

export interface CodeFix {
    description: string;
    original?: string | undefined;
    replacement: string;
    autoFixable: boolean;
}

// ============================================================================
// Fix Result Types
// ============================================================================

export interface FixResult {
    issue: CodeIssue;
    applied: boolean;
    error?: string;
    originalContent?: string;
    newContent?: string;
}

export interface FixSummary {
    totalIssues: number;
    fixed: number;
    skipped: number;
    failed: number;
    fixes: FixResult[];
}

// ============================================================================
// Node Visualization Types
// ============================================================================

export interface FileNode {
    id: string;
    filePath: string;
    fileName: string;
    language: string;
    exports: string[];
    imports: FileImport[];
    position?: { x: number; y: number };
}

export interface FileImport {
    from: string;
    imported: string[];
    isRelative: boolean;
}

export interface FileEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    type: 'imports' | 'provides' | 'calls';
}

export interface FileGraph {
    nodes: FileNode[];
    edges: FileEdge[];
}

// ============================================================================
// Workflow Node Types (Planning View)
// ============================================================================

export interface WorkflowStep {
    id: string;
    title: string;
    description: string;
    type: 'action' | 'decision' | 'input' | 'output';
    position?: { x: number; y: number };
}

export interface WorkflowConnection {
    id: string;
    source: string;
    target: string;
    label?: string;
    condition?: string;
}

export interface WorkflowGraph {
    id: string;
    name: string;
    steps: WorkflowStep[];
    connections: WorkflowConnection[];
}

// ============================================================================
// User Comment Types (for visual elements)
// ============================================================================

export interface VisualComment {
    id: string;
    targetType: 'node' | 'edge' | 'area';
    targetIds: string[];
    content: string;
    createdAt: Date;
    resolved: boolean;
    aiResponse?: string;
}

// ============================================================================
// Report Types
// ============================================================================

export interface SecurityReport {
    id: string;
    projectName: string;
    generatedAt: Date;
    summary: ReportSummary;
    findings: ReportFinding[];
    recommendations: string[];
}

export interface ReportSummary {
    totalIssues: number;
    bySeverity: Record<IssueSeverity, number>;
    byCategory: Record<IssueCategory, number>;
    riskScore: number;
}

export interface ReportFinding {
    issue: CodeIssue;
    remediation: string;
    references: string[];
    cweId?: string;
    owaspCategory?: string;
}
