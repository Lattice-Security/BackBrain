import { SEVERITY_ORDER } from '../ports';
import type {
    IssueSourceType,
    SecurityScanContext,
    SecurityScanStatusUpdate,
    SecurityIssue,
    SecurityScanner,
    Severity,
    VerificationStatus,
} from '../ports';
import type { CodeIssue, CodeFix, CodeLocation, IssueCategory, IssueSeverity } from '../types';
import { getLogger } from '../utils/logger';
import { toError } from '../utils/result';
import { providerRegistry } from './provider-registry';

export interface SecurityScanOptions {
    /** Minimum severity to include */
    minSeverity?: Severity;
    /** Specific files to scan (if empty, uses all) */
    files?: string[];
    /** Scanner names to use (if empty, uses all registered) */
    scanners?: string[];
    /** Optional status callback for scan progress and degraded mode */
    onStatus?: (update: SecurityScanStatusUpdate) => void;
}

export interface SecurityScanResult {
    issues: CodeIssue[];
    scannedFiles: string[];
    scanDurationMs: number;
    scannersUsed: string[];
}

export interface ScannerStatus {
    id: string;
    available: boolean;
    scanKind: 'deterministic' | 'agent';
    supportedExtensions: string[];
}

function normalizeText(value: string | undefined): string {
    return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getIssueDedupKey(issue: SecurityIssue): string {
    return [
        issue.filePath,
        issue.line,
        issue.endLine || '',
        normalizeText(issue.ruleId || issue.title),
        normalizeText(issue.title),
    ].join('|');
}

function mergeSecurityIssue(existing: SecurityIssue, incoming: SecurityIssue): SecurityIssue {
    const sources = new Set(
        [existing.source, incoming.source]
            .flatMap(value => (value || '').split(','))
            .map(value => value.trim())
            .filter(Boolean)
    );
    const confidenceRank = { high: 3, medium: 2, low: 1 } as const;
    const mergedConfidence = [existing.confidence, incoming.confidence]
        .filter((value): value is NonNullable<SecurityIssue['confidence']> => value !== undefined)
        .sort((left, right) => confidenceRank[right] - confidenceRank[left])[0];

    const merged: SecurityIssue = {
        ...existing,
        description: existing.description.length >= incoming.description.length
            ? existing.description
            : incoming.description,
    };
    const mergedSourceType = mergeSourceType(existing.sourceType, incoming.sourceType);
    const mergedVerificationStatus = mergedSourceType === 'deterministic'
        ? 'not_applicable'
        : mergeVerificationStatus(existing.verificationStatus, incoming.verificationStatus);

    const mergedReferences = Array.from(new Set([...(existing.references || []), ...(incoming.references || [])]));
    if (mergedReferences.length > 0) {
        merged.references = mergedReferences;
    }
    const mergedSource = sources.size > 0 ? Array.from(sources).join(', ') : existing.source || incoming.source;
    if (mergedSource) {
        merged.source = mergedSource;
    }
    if (mergedConfidence) {
        merged.confidence = mergedConfidence;
    }
    const mergedSnippet = existing.snippet || incoming.snippet;
    if (mergedSnippet) {
        merged.snippet = mergedSnippet;
    }
    const mergedSuggestedFix = existing.suggestedFix || incoming.suggestedFix;
    if (mergedSuggestedFix) {
        merged.suggestedFix = mergedSuggestedFix;
    }
    if (mergedSourceType) {
        merged.sourceType = mergedSourceType;
    }
    if (mergedVerificationStatus) {
        merged.verificationStatus = mergedVerificationStatus;
    }
    if (existing.groundedByDeterministicFindings || incoming.groundedByDeterministicFindings) {
        merged.groundedByDeterministicFindings = true;
    }
    const mergedBackend = existing.backend || incoming.backend;
    if (mergedBackend) {
        merged.backend = mergedBackend;
    }
    const mergedSourceRoles = Array.from(new Set([...(existing.sourceRoles || []), ...(incoming.sourceRoles || [])]));
    if (mergedSourceRoles.length > 0) {
        merged.sourceRoles = mergedSourceRoles;
    }
    const mergedRelatedIssueIds = Array.from(new Set([...(existing.relatedIssueIds || []), ...(incoming.relatedIssueIds || [])]));
    if (mergedRelatedIssueIds.length > 0) {
        merged.relatedIssueIds = mergedRelatedIssueIds;
    }
    if (existing.degraded || incoming.degraded) {
        merged.degraded = true;
    }

    return merged;
}

function dedupeSecurityIssues(issues: SecurityIssue[]): SecurityIssue[] {
    const deduped = new Map<string, SecurityIssue>();

    for (const issue of issues) {
        const key = getIssueDedupKey(issue);
        const existing = deduped.get(key);
        if (existing) {
            deduped.set(key, mergeSecurityIssue(existing, issue));
        } else {
            deduped.set(key, issue);
        }
    }

    return Array.from(deduped.values());
}

/**
 * Convert security issue to code issue
 */
function toCodeIssue(issue: SecurityIssue): CodeIssue {
    const location: CodeLocation = {
        filePath: issue.filePath,
        line: issue.line,
    };
    if (issue.column !== undefined) location.column = issue.column;
    if (issue.endLine !== undefined) location.endLine = issue.endLine;

    const fix: CodeFix | undefined = issue.suggestedFix ? {
        description: issue.suggestedFix.description,
        original: issue.suggestedFix.original,
        replacement: issue.suggestedFix.replacement,
        autoFixable: issue.suggestedFix.autoFixable,
    } : undefined;

    // Generate a stable ID based on content and location
    // We use a simple string concatenation for now, but including the description
    // makes it much more stable than just line number.
    const contentHash = issue.description.substring(0, 10).replace(/\s+/g, '_');
    const id = `sec-${issue.ruleId}-${issue.filePath}-${issue.line}-${contentHash}`;

    const result: CodeIssue = {
        id,
        type: 'security_vulnerability',
        title: issue.title,
        description: issue.description,
        location,
        severity: issue.severity as IssueSeverity,
        category: 'security' as IssueCategory,
    };

    if (fix !== undefined) {
        result.suggestedFix = fix;
    }
    if (issue.source !== undefined) {
        result.source = issue.source;
    }
    if (issue.confidence !== undefined) {
        result.confidence = issue.confidence;
    }
    if (issue.sourceType !== undefined) {
        result.sourceType = issue.sourceType;
    }
    if (issue.groundedByDeterministicFindings !== undefined) {
        result.groundedByDeterministicFindings = issue.groundedByDeterministicFindings;
    }
    if (issue.verificationStatus !== undefined) {
        result.verificationStatus = issue.verificationStatus;
    }
    if (issue.backend !== undefined) {
        result.backend = issue.backend;
    }
    if (issue.sourceRoles !== undefined) {
        result.sourceRoles = issue.sourceRoles;
    }
    if (issue.relatedIssueIds !== undefined) {
        result.relatedIssueIds = issue.relatedIssueIds;
    }
    if (issue.degraded !== undefined) {
        result.degraded = issue.degraded;
    }

    return result;
}

function mergeSourceType(
    left?: IssueSourceType,
    right?: IssueSourceType,
): IssueSourceType | undefined {
    const sourceTypes = [left, right];
    if (sourceTypes.includes('deterministic')) {
        return 'deterministic';
    }
    if (sourceTypes.includes('agent-grounded')) {
        return 'agent-grounded';
    }
    if (sourceTypes.includes('agent-only')) {
        return 'agent-only';
    }
    return undefined;
}

function mergeVerificationStatus(
    left?: VerificationStatus,
    right?: VerificationStatus,
): VerificationStatus | undefined {
    const rank: Record<VerificationStatus, number> = {
        verified: 3,
        not_applicable: 2,
        unverified: 1,
    };
    const statuses = [left, right].filter((value): value is VerificationStatus => value !== undefined);
    return statuses.sort((a, b) => rank[b] - rank[a])[0];
}

function emitStatus(
    reporter: SecurityScanOptions['onStatus'] | SecurityScanContext['reportStatus'],
    update: SecurityScanStatusUpdate,
): void {
    reporter?.(update);
}

function normalizeScannerIssues(scanner: SecurityScanner, issues: SecurityIssue[]): SecurityIssue[] {
    return issues.map((issue) => {
        const sourceType = issue.sourceType
            ?? (scanner.scanKind === 'agent'
                ? (issue.groundedByDeterministicFindings ? 'agent-grounded' : 'agent-only')
                : 'deterministic');
        const verificationStatus = issue.verificationStatus
            ?? (sourceType === 'deterministic' ? 'not_applicable' : 'unverified');

        return {
            ...issue,
            source: issue.source || scanner.name,
            sourceType,
            verificationStatus,
        };
    });
}

async function runScannerSafely(
    scanner: SecurityScanner,
    paths: string[],
    logger: ReturnType<typeof getLogger>,
    context?: SecurityScanContext,
): Promise<{ issues: SecurityIssue[]; scannedFiles: string[]; usedScanner?: string }> {
    try {
        logger.debug(`Running ${scanner.scanKind === 'agent' ? 'agent ' : ''}scanner: ${scanner.name}`);
        const result = context && scanner.scanWithContext
            ? await scanner.scanWithContext(paths, context)
            : await scanner.scan(paths);
        logger.debug(`Scanner ${scanner.name} found ${result.issues.length} issues`);
        return {
            issues: normalizeScannerIssues(scanner, result.issues),
            scannedFiles: result.scannedFiles,
            usedScanner: scanner.name,
        };
    } catch (error) {
        logger.error(`${scanner.scanKind === 'agent' ? 'Agent scanner' : 'Scanner'} ${scanner.name} failed`, {
            error: toError(error),
        });
        emitStatus(context?.reportStatus, {
            phase: 'degraded',
            level: 'warn',
            message: `${scanner.name} failed; continuing with remaining scanners.`,
            scanner: scanner.name,
            degraded: true,
        });
        return {
            issues: [],
            scannedFiles: [],
        };
    }
}

/**
 * Filter issues by minimum severity
 */
function filterBySeverity(issues: SecurityIssue[], minSeverity: Severity): SecurityIssue[] {
    const minIndex = SEVERITY_ORDER.indexOf(minSeverity);

    return issues.filter(issue => {
        const issueIndex = SEVERITY_ORDER.indexOf(issue.severity);
        return issueIndex <= minIndex;
    });
}

/**
 * Run security scan using registered scanners
 */
export async function runSecurityScan(
    paths: string[],
    options: SecurityScanOptions = {}
): Promise<SecurityScanResult> {
    const logger = getLogger();
    const startTime = Date.now();

    // Get scanners to use
    const scannerNames = options.scanners ?? providerRegistry.listScanners();
    const scanners: SecurityScanner[] = [];

    for (const name of scannerNames) {
        const scanner = providerRegistry.getScanner(name);
        if (scanner) {
            const available = await scanner.isAvailable();
            if (available) {
                scanners.push(scanner);
            } else {
                logger.warn(`Scanner ${name} is not available`);
                emitStatus(options.onStatus, {
                    phase: 'degraded',
                    level: 'warn',
                    message: `${name} is unavailable. Coverage will be limited.`,
                    scanner: name,
                    degraded: true,
                });
            }
        }
    }

    if (scanners.length === 0) {
        logger.warn('No security scanners available');
        emitStatus(options.onStatus, {
            phase: 'skipped',
            level: 'warn',
            message: 'No security scanners are available.',
            degraded: true,
        });
        return {
            issues: [],
            scannedFiles: [],
            scanDurationMs: Date.now() - startTime,
            scannersUsed: [],
        };
    }

    logger.info(`Starting security scan with ${scanners.length} scanner(s)`, { paths });

    const deterministicScanners = scanners.filter(scanner => scanner.scanKind !== 'agent');
    const agentScanners = scanners.filter(scanner => scanner.scanKind === 'agent');
    const reportStatus = options.onStatus;

    // Run deterministic scanners first
    const allIssues: SecurityIssue[] = [];
    const allFiles = new Set<string>();
    const usedScanners: string[] = [];

    if (deterministicScanners.length > 0) {
        emitStatus(reportStatus, {
            phase: 'deterministic',
            level: 'info',
            message: `Running ${deterministicScanners.length} deterministic scanner(s).`,
        });
    }

    const deterministicResults = await Promise.all(
        deterministicScanners.map(scanner => runScannerSafely(
            scanner,
            paths,
            logger,
            reportStatus ? { reportStatus } : undefined,
        ))
    );

    for (const result of deterministicResults) {
        allIssues.push(...result.issues);
        result.scannedFiles.forEach(f => allFiles.add(f));
        if (result.usedScanner) {
            usedScanners.push(result.usedScanner);
        }
    }

    const dedupedDeterministicIssues = dedupeSecurityIssues(allIssues);

    const agentContext: SecurityScanContext = {
        deterministicIssues: dedupedDeterministicIssues,
        requestedPaths: paths,
        ...(reportStatus ? { reportStatus } : {}),
    };

    for (const scanner of agentScanners) {
        const result = await runScannerSafely(scanner, paths, logger, agentContext);
        allIssues.push(...result.issues);
        result.scannedFiles.forEach(f => allFiles.add(f));
        if (result.usedScanner) {
            usedScanners.push(result.usedScanner);
        }
    }

    const dedupedAllIssues = dedupeSecurityIssues(allIssues);

    // Filter by severity if specified
    const filteredIssues = options.minSeverity
        ? filterBySeverity(dedupedAllIssues, options.minSeverity)
        : dedupedAllIssues;

    // Convert to CodeIssue type
    const codeIssues = filteredIssues.map(toCodeIssue);

    const duration = Date.now() - startTime;
    logger.info(`Security scan complete`, {
        issuesFound: codeIssues.length,
        filesScanned: allFiles.size,
        durationMs: duration,
    });
    emitStatus(reportStatus, {
        phase: 'complete',
        level: 'info',
        message: `Scan complete: ${codeIssues.length} issue(s), ${usedScanners.length} scanner(s) used.`,
    });

    return {
        issues: codeIssues,
        scannedFiles: Array.from(allFiles),
        scanDurationMs: duration,
        scannersUsed: usedScanners,
    };
}

/**
 * Scan a single file
 */
export async function scanFile(
    filePath: string,
    content: string,
    scannerName?: string
): Promise<CodeIssue[]> {
    const scanner = providerRegistry.getScanner(scannerName);

    if (!scanner) {
        return [];
    }

    const issues = await scanner.scanFile(filePath, content);
    return issues.map(toCodeIssue);
}

/**
 * SecurityService class for dependency injection
 */
export class SecurityService {
    constructor(private scanners: SecurityScanner[]) {
        // Register all scanners
        scanners.forEach(scanner => {
            providerRegistry.registerScanner(scanner.name, scanner);
        });
    }

    async scanFile(filePath: string, content: string, options: SecurityScanOptions = {}): Promise<SecurityScanResult> {
        const issues: CodeIssue[] = [];
        const scannersUsed: string[] = [];
        const deterministicIssues: SecurityIssue[] = [];
        const reportStatus = options.onStatus;

        const enabledScannerNames = options.scanners ? new Set(options.scanners) : null;
        const selectedScanners = enabledScannerNames
            ? this.scanners.filter(scanner => enabledScannerNames.has(scanner.name))
            : this.scanners;
        const deterministicScanners = selectedScanners.filter(scanner => scanner.scanKind !== 'agent');
        const agentScanners = selectedScanners.filter(scanner => scanner.scanKind === 'agent');

        if (deterministicScanners.length > 0) {
            emitStatus(reportStatus, {
                phase: 'deterministic',
                level: 'info',
                message: `Running ${deterministicScanners.length} deterministic scanner(s) on the current file.`,
            });
        }

        const deterministicResults = await Promise.all(
            deterministicScanners.map(async (scanner) => {
                try {
                    const available = await scanner.isAvailable();
                    if (!available) {
                        emitStatus(reportStatus, {
                            phase: 'degraded',
                            level: 'warn',
                            message: `${scanner.name} is unavailable. Coverage will be limited.`,
                            scanner: scanner.name,
                            degraded: true,
                        });
                        return { scannerName: scanner.name, issues: [] as SecurityIssue[] };
                    }

                    const scannerIssues = await scanner.scanFile(filePath, content);
                    return { scannerName: scanner.name, issues: normalizeScannerIssues(scanner, scannerIssues) };
                } catch {
                    emitStatus(reportStatus, {
                        phase: 'degraded',
                        level: 'warn',
                        message: `${scanner.name} failed on the current file.`,
                        scanner: scanner.name,
                        degraded: true,
                    });
                    return { scannerName: scanner.name, issues: [] as SecurityIssue[] };
                }
            })
        );

        for (const result of deterministicResults) {
            if (result.issues.length > 0) {
                deterministicIssues.push(...result.issues);
                scannersUsed.push(result.scannerName);
            }
        }

        const dedupedDeterministicIssues = dedupeSecurityIssues(deterministicIssues);
        issues.push(...dedupedDeterministicIssues.map(toCodeIssue));

        const agentContext: SecurityScanContext = {
            deterministicIssues: dedupedDeterministicIssues,
            requestedPaths: [filePath],
            ...(reportStatus ? { reportStatus } : {}),
        };

        for (const scanner of agentScanners) {
            try {
                const available = await scanner.isAvailable();
                if (!available) {
                    emitStatus(reportStatus, {
                        phase: 'degraded',
                        level: 'warn',
                        message: `${scanner.name} is unavailable. AI review was skipped.`,
                        scanner: scanner.name,
                        degraded: true,
                    });
                    continue;
                }

                const result = scanner.scanWithContext
                    ? await scanner.scanWithContext([filePath], agentContext)
                    : await scanner.scan([filePath]);
                issues.push(...dedupeSecurityIssues(normalizeScannerIssues(scanner, result.issues)).map(toCodeIssue));
                scannersUsed.push(scanner.name);
            } catch {
                emitStatus(reportStatus, {
                    phase: 'degraded',
                    level: 'warn',
                    message: `${scanner.name} failed during AI review.`,
                    scanner: scanner.name,
                    degraded: true,
                });
                continue;
            }
        }

        const dedupedCodeIssues = Array.from(new Map(issues.map(issue => {
            const key = [
                issue.location.filePath,
                issue.location.line,
                issue.title.toLowerCase(),
                issue.ruleId || '',
            ].join('|');
            return [key, issue] as const;
        })).values());

        return {
            issues: dedupedCodeIssues,
            scannedFiles: [filePath],
            scanDurationMs: 0,
            scannersUsed,
        };
    }

    async scan(paths: string[], options?: SecurityScanOptions): Promise<SecurityScanResult> {
        return runSecurityScan(paths, options);
    }

    /**
     * Get all supported extensions from available scanners
     */
    async getSupportedExtensions(): Promise<string[]> {
        const extensions = new Set<string>();
        for (const scanner of this.scanners) {
            const available = await scanner.isAvailable();
            if (available) {
                scanner.getSupportedExtensions().forEach(ext => extensions.add(ext));
            }
        }
        return Array.from(extensions);
    }

    async getScannerStatuses(): Promise<ScannerStatus[]> {
        const statuses: ScannerStatus[] = [];
        for (const scanner of this.scanners) {
            let available = false;
            try {
                available = await scanner.isAvailable();
            } catch {
                available = false;
            }
            statuses.push({
                id: scanner.name,
                available,
                scanKind: scanner.scanKind === 'agent' ? 'agent' : 'deterministic',
                supportedExtensions: scanner.getSupportedExtensions(),
            });
        }
        return statuses;
    }
}
