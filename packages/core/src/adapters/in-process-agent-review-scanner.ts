import { generateObject } from 'ai';
import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';

import type {
    ScanResult,
    SecurityIssue,
    SecurityScanContext,
    SecurityScanStatusUpdate,
    SecurityScanner,
    Severity,
} from '../ports';
import { createLogger } from '../utils/logger';
import { toError } from '../utils/result';
import { loadKnowledge, formatKnowledgeBlock } from '../config/knowledge-loader.js';
import type { VercelAIAdapter } from './vercel-ai-adapter';

const logger = createLogger('InProcessAgentReviewScanner');

// ============================================================================
// Public types — re-exported from here so extension.ts does not depend on
// the deleted cli-agent-review-scanner.ts
// ============================================================================

export type AgentScanDepth = 'developer' | 'team' | 'security' | 'audit';

export function resolveScanDepthConfig(depth: AgentScanDepth): {
    maxSpecialists: number;
    concurrency: number;
    delayBetweenCallsMs: number;
    label: string;
} {
    switch (depth) {
        case 'audit':
            return { maxSpecialists: 6, concurrency: 3, delayBetweenCallsMs: 0, label: 'Audit Scan' };
        case 'security':
            return { maxSpecialists: 4, concurrency: 2, delayBetweenCallsMs: 1000, label: 'Security Scan' };
        case 'team':
            return { maxSpecialists: 3, concurrency: 1, delayBetweenCallsMs: 2000, label: 'Team Scan' };
        case 'developer':
        default:
            return { maxSpecialists: 2, concurrency: 1, delayBetweenCallsMs: 3000, label: 'Developer Scan' };
    }
}

// ============================================================================
// Zod schemas (same shapes as the deleted CLI scanner — pipeline is identical)
// ============================================================================

const plannerSchema = z.object({
    repoSummary: z.string().min(1),
    specialists: z.array(z.object({
        name: z.string().min(1),
        rationale: z.string().min(1),
        focus: z.string().min(1),
        paths: z.array(z.string()).default([]),
        checks: z.array(z.string()).min(1),
        relevantFindingIds: z.array(z.string()).optional(),
    })).max(12),
});

const specialistSchema = z.object({
    findings: z.array(z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        confidence: z.enum(['high', 'medium', 'low']),
        filePath: z.string().min(1),
        line: z.number().int().positive().optional(),
        evidence: z.string().min(1),
        remediation: z.string().min(1),
    })),
});

const aggregatorSchema = z.object({
    findings: z.array(z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        confidence: z.enum(['high', 'medium', 'low']),
        filePath: z.string().min(1),
        line: z.number().int().positive().optional(),
        evidence: z.string().min(1),
        remediation: z.string().min(1),
        sourceRoles: z.array(z.string()).default([]),
        groundedByDeterministicFindings: z.boolean().default(false),
        linkedDeterministicFindingIds: z.array(z.string()).default([]),
    })),
});

type PlannerOutput = z.infer<typeof plannerSchema>;
type SpecialistOutput = z.infer<typeof specialistSchema>;
type AggregatorOutput = z.infer<typeof aggregatorSchema>;

// ============================================================================
// Options
// ============================================================================

export interface InProcessAgentReviewScannerOptions {
    adapter?: VercelAIAdapter | null;
    maxSpecialists?: number;
    specialistConcurrency?: number;
    delayBetweenCallsMs?: number;
    reviewScope?: 'workspace' | 'changed-files' | 'both';
}

// ============================================================================
// Limits for context pre-fetching
// ============================================================================

/** Max bytes of a single file to include in a specialist prompt */
const MAX_FILE_BYTES = 32_000;
/** Max total file bytes included in one specialist prompt */
const MAX_TOTAL_CONTEXT_BYTES = 96_000;
/** Max files to list while building the planner repo tree */
const MAX_DIR_LIST_FILES = 200;

// ============================================================================
// Scanner
// ============================================================================

export class InProcessAgentReviewScanner implements SecurityScanner {
    readonly name = 'agent-review';
    readonly scanKind = 'agent' as const;

    private adapter: VercelAIAdapter | null;
    private maxSpecialists: number;
    private specialistConcurrency: number;
    private delayBetweenCallsMs: number;
    private reviewScope: 'workspace' | 'changed-files' | 'both';

    constructor(options: InProcessAgentReviewScannerOptions = {}) {
        this.adapter = options.adapter ?? null;
        this.maxSpecialists = Math.max(1, options.maxSpecialists ?? 6);
        this.specialistConcurrency = Math.max(1, options.specialistConcurrency ?? 3);
        this.delayBetweenCallsMs = Math.max(0, options.delayBetweenCallsMs ?? 0);
        this.reviewScope = options.reviewScope ?? 'both';
    }

    configure(options: InProcessAgentReviewScannerOptions): void {
        if (options.adapter !== undefined) this.adapter = options.adapter;
        if (options.maxSpecialists !== undefined) this.maxSpecialists = Math.max(1, options.maxSpecialists);
        if (options.specialistConcurrency !== undefined) this.specialistConcurrency = Math.max(1, options.specialistConcurrency);
        if (options.delayBetweenCallsMs !== undefined) this.delayBetweenCallsMs = Math.max(0, options.delayBetweenCallsMs);
        if (options.reviewScope !== undefined) this.reviewScope = options.reviewScope;
    }

    getSupportedExtensions(): string[] {
        return ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php', '.json', '.yaml', '.yml', '.toml'];
    }

    async isAvailable(): Promise<boolean> {
        if (!this.adapter) return false;
        return this.adapter.isAvailable();
    }

    async scanFile(filePath: string): Promise<SecurityIssue[]> {
        const result = await this.scanWithContext([filePath], { deterministicIssues: [] });
        return result.issues;
    }

    async scan(paths: string[]): Promise<ScanResult> {
        return this.scanWithContext(paths, { deterministicIssues: [] });
    }

    async scanWithContext(paths: string[], context: SecurityScanContext): Promise<ScanResult> {
        const startTime = Date.now();

        if (!this.adapter || !(await this.adapter.isAvailable())) {
            logger.warn('Skipping agent review: no AI provider configured');
            this.reportStatus(context, {
                phase: 'skipped',
                level: 'warn',
                message: 'AI review skipped: configure an API key in BackBrain settings to enable.',
                degraded: true,
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: 'AI Agent Review (no provider configured)',
            };
        }

        const model = this.adapter.getModel();
        const repositoryRoot = context.repositoryRoot || this.detectRepositoryRoot(paths);
        const changedFiles = context.changedFiles || await this.detectChangedFiles(repositoryRoot);
        const effectivePaths = this.getEffectiveScanPaths(paths, changedFiles, repositoryRoot);
        const deterministicIssues = context.deterministicIssues || [];

        logger.info('Starting in-process agent review', {
            repositoryRoot,
            pathCount: effectivePaths.length,
            deterministicIssueCount: deterministicIssues.length,
            changedFileCount: changedFiles.length,
            reviewScope: this.reviewScope,
            maxSpecialists: this.maxSpecialists,
        });

        // ── Planner ─────────────────────────────────────────────────────────
        this.reportStatus(context, {
            phase: 'agent-planner',
            level: 'info',
            message: 'AI review planner analysing repository structure.',
        });

        const knowledge = loadKnowledge();
        if (knowledge) {
            logger.info('Loaded security intelligence context', {
                trends: knowledge.trends.split('\n').filter(l => l.startsWith('- ')).length,
                catalog: knowledge.vulnerabilityCatalog.split('\n').filter(l => l.startsWith('- ')).length,
            });
        } else {
            logger.warn('Security intelligence context not available — knowledge files missing from packages/core/src/knowledge/');
        }

        let planner: PlannerOutput;
        try {
            const repoTree = await this.buildRepoTree(repositoryRoot, 3);
            const promptParts: string[] = [
                `Repository root: ${repositoryRoot}`,
                `Requested scan paths:\n${effectivePaths.join('\n')}`,
                `Changed files:\n${changedFiles.join('\n') || 'none detected'}`,
                'Deterministic findings:',
                this.summarizeDeterministicIssues(deterministicIssues),
                'Repository structure:',
                repoTree,
            ];
            if (knowledge) {
                promptParts.push(formatKnowledgeBlock(knowledge));
            }
            const plannerResult = await generateObject({
                model,
                schema: plannerSchema,
                system: [
                    'You are the lead security planning agent for a codebase security review.',
                    'Inspect the repository structure provided and decide which specialist reviewers are needed.',
                    'Prefer reviewing changed files and the requested scan paths.',
                    `Emit at most ${this.maxSpecialists} specialists.`,
                    'Each specialist must have: a unique role name, rationale, focus area, relevant paths, and specific security checks.',
                ].join('\n'),
                prompt: promptParts.join('\n\n'),
            });
            planner = plannerResult.object;
        } catch (error) {
            logger.warn('Agent review planner failed; skipping AI review', { error: toError(error) });
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: 'AI review planner failed; deterministic results only.',
                degraded: true,
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: 'AI Agent Review (planner failed)',
            };
        }

        const specialists = planner.specialists.slice(0, this.maxSpecialists);
        logger.info('Agent review planner completed', {
            specialistCount: specialists.length,
            specialistNames: specialists.map(s => s.name),
        });

        if (specialists.length === 0) {
            this.reportStatus(context, {
                phase: 'skipped',
                level: 'info',
                message: 'AI review planner did not select any specialist reviewers.',
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: 'AI Agent Review (no specialists selected)',
            };
        }

        // ── Specialists ─────────────────────────────────────────────────────
        this.reportStatus(context, {
            phase: 'agent-specialists',
            level: 'info',
            message: `Running ${specialists.length} AI specialist review(s).`,
        });

        const specialistOutcomes = await this.runWithConcurrency(
            specialists,
            this.specialistConcurrency,
            (specialist) => this.runSpecialistSafely(specialist, model, {
                repositoryRoot,
                deterministicIssues,
                changedFiles,
                repoSummary: planner.repoSummary,
            })
        );

        const specialistResults = specialistOutcomes.filter(
            (r): r is NonNullable<typeof r> => r !== null
        );
        const failedSpecialists = specialistOutcomes.length - specialistResults.length;

        logger.info('Agent review specialists completed', {
            succeeded: specialistResults.length,
            failed: failedSpecialists,
            totalFindings: specialistResults.reduce((n, r) => n + r.findings.length, 0),
        });

        if (failedSpecialists > 0) {
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: `${failedSpecialists} AI specialist review(s) failed; continuing with partial coverage.`,
                degraded: true,
            });
        }

        const rawAgentFindings = specialistResults.flatMap(result =>
            result.findings.map(finding => ({ ...finding, roleName: result.roleName }))
        );

        // ── Aggregator ───────────────────────────────────────────────────────
        this.reportStatus(context, {
            phase: 'agent-aggregator',
            level: 'info',
            message: 'Merging AI specialist findings.',
        });

        let aggregatedFindings: AggregatorOutput['findings'];
        let usedFallbackAggregation = false;

        try {
            const aggregatorResult = await generateObject({
                model,
                schema: aggregatorSchema,
                system: [
                    'You are the final security finding aggregator.',
                    'Merge duplicate findings, prefer deterministic findings when they cover the same issue.',
                    'Drop speculative findings without concrete code evidence.',
                    'Indicate whether each finding is grounded in deterministic findings.',
                ].join('\n'),
                prompt: [
                    `Repository summary: ${planner.repoSummary}`,
                    'Deterministic findings:',
                    this.summarizeDeterministicIssues(deterministicIssues),
                    'Agent specialist findings:',
                    JSON.stringify(rawAgentFindings, null, 2),
                ].join('\n\n'),
            });
            aggregatedFindings = aggregatorResult.object.findings;
            logger.info('Agent review aggregation completed', { finalFindingCount: aggregatedFindings.length });
        } catch (error) {
            usedFallbackAggregation = true;
            logger.warn('Agent review aggregator failed; falling back to raw specialist findings', { error: toError(error) });
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: 'AI aggregation failed; using verified specialist findings directly.',
                degraded: true,
            });
            aggregatedFindings = rawAgentFindings.map(f => ({
                title: f.title,
                description: f.description,
                severity: f.severity,
                confidence: f.confidence,
                filePath: f.filePath,
                line: f.line,
                evidence: f.evidence,
                remediation: f.remediation,
                sourceRoles: [f.roleName],
                groundedByDeterministicFindings: false,
                linkedDeterministicFindingIds: [],
            }));
        }

        // ── Verification ─────────────────────────────────────────────────────
        this.reportStatus(context, {
            phase: 'agent-verification',
            level: 'info',
            message: 'Verifying AI findings against the current workspace state.',
        });

        const verifiedIssues = await this.verifyAgentFindings(aggregatedFindings, repositoryRoot, {
            degraded: usedFallbackAggregation || failedSpecialists > 0,
            deterministicIssues,
        });

        const verifiedCount = verifiedIssues.filter(i => i.verificationStatus === 'verified').length;
        const downgradedCount = verifiedIssues.filter(i => i.verificationStatus === 'unverified').length;

        if (downgradedCount > 0) {
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: `${downgradedCount} AI finding(s) could not be fully verified and were downgraded.`,
                degraded: true,
            });
        }

        return {
            issues: verifiedIssues,
            scannedFiles: paths,
            scanDurationMs: Date.now() - startTime,
            scannerInfo: `AI Agent Review (in-process, verified: ${verifiedCount}, downgraded: ${downgradedCount})`,
        };
    }

    // ── Specialist execution ─────────────────────────────────────────────────

    private async runSpecialist(
        specialist: PlannerOutput['specialists'][number],
        model: ReturnType<VercelAIAdapter['getModel']>,
        context: {
            repositoryRoot: string;
            deterministicIssues: SecurityIssue[];
            changedFiles: string[];
            repoSummary: string;
        }
    ): Promise<{ roleName: string; findings: SpecialistOutput['findings'] }> {
        logger.info('Running in-process specialist', {
            roleName: specialist.name,
            scopedPaths: specialist.paths,
            checkCount: specialist.checks.length,
        });

        const relevantIds = new Set(specialist.relevantFindingIds || []);
        const relevantFindings = context.deterministicIssues.filter(issue =>
            relevantIds.size === 0 || relevantIds.has(issue.ruleId)
        );

        // Pre-fetch files in scope so the LLM can read them without tool calls
        const fileContext = await this.fetchFileContext(specialist.paths, context.repositoryRoot);

        const result = await generateObject({
            model,
            schema: specialistSchema,
            system: [
                `You are a specialist security reviewer named "${specialist.name}".`,
                'You are operating in read-only mode.',
                'Only report findings with concrete code evidence from the files provided below.',
                'Every finding must cite exact code evidence and the most specific line number you can justify.',
                'Do not include speculative findings without concrete code evidence.',
            ].join('\n'),
            prompt: [
                `Repository summary: ${context.repoSummary}`,
                `Assigned focus: ${specialist.focus}`,
                `Rationale: ${specialist.rationale}`,
                `Scope paths: ${specialist.paths.join(', ') || 'use your judgement within the requested scan area'}`,
                `Changed files:\n${context.changedFiles.join('\n') || 'none detected'}`,
                'Checks to perform:',
                specialist.checks.map((check, i) => `${i + 1}. ${check}`).join('\n'),
                'Relevant deterministic findings:',
                this.summarizeDeterministicIssues(relevantFindings),
                'File contents for review:',
                fileContext || '(no files could be read in scope — report based on path names only if confident)',
            ].join('\n\n'),
        });

        logger.info('In-process specialist completed', {
            roleName: specialist.name,
            findingCount: result.object.findings.length,
        });

        return { roleName: specialist.name, findings: result.object.findings };
    }

    private async runSpecialistSafely(
        specialist: PlannerOutput['specialists'][number],
        model: ReturnType<VercelAIAdapter['getModel']>,
        context: {
            repositoryRoot: string;
            deterministicIssues: SecurityIssue[];
            changedFiles: string[];
            repoSummary: string;
        }
    ): Promise<{ roleName: string; findings: SpecialistOutput['findings'] } | null> {
        try {
            return await this.runSpecialist(specialist, model, context);
        } catch (error) {
            logger.warn('In-process specialist failed', { roleName: specialist.name, error: toError(error) });
            return null;
        }
    }

    // ── File context pre-fetching ────────────────────────────────────────────

    private async fetchFileContext(scopePaths: string[], repositoryRoot: string): Promise<string> {
        const chunks: string[] = [];
        let totalBytes = 0;

        for (const scopePath of scopePaths) {
            if (totalBytes >= MAX_TOTAL_CONTEXT_BYTES) break;

            const resolvedPath = path.isAbsolute(scopePath)
                ? scopePath
                : path.join(repositoryRoot, scopePath);

            try {
                const stat = await fs.stat(resolvedPath);
                if (stat.isDirectory()) {
                    const files = await this.listFilesRecursive(resolvedPath, 2);
                    for (const filePath of files) {
                        if (totalBytes >= MAX_TOTAL_CONTEXT_BYTES) break;
                        const chunk = await this.readFileSafe(filePath, repositoryRoot);
                        if (chunk) {
                            chunks.push(chunk);
                            totalBytes += chunk.length;
                        }
                    }
                } else {
                    const chunk = await this.readFileSafe(resolvedPath, repositoryRoot);
                    if (chunk) {
                        chunks.push(chunk);
                        totalBytes += chunk.length;
                    }
                }
            } catch {
                // Path doesn't exist or isn't readable — skip silently
            }
        }

        return chunks.join('\n\n');
    }

    private async readFileSafe(filePath: string, repositoryRoot: string): Promise<string | null> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const truncated = content.length > MAX_FILE_BYTES
                ? content.slice(0, MAX_FILE_BYTES) + '\n// ... (file truncated)'
                : content;
            const relPath = path.relative(repositoryRoot, filePath);
            return `// FILE: ${relPath}\n${truncated}`;
        } catch {
            return null;
        }
    }

    private async listFilesRecursive(dir: string, maxDepth: number): Promise<string[]> {
        if (maxDepth <= 0) return [];
        const results: string[] = [];
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const nested = await this.listFilesRecursive(fullPath, maxDepth - 1);
                    results.push(...nested);
                } else {
                    results.push(fullPath);
                }
                if (results.length >= MAX_DIR_LIST_FILES) break;
            }
        } catch {
            // Unreadable directory — skip
        }
        return results;
    }

    private async buildRepoTree(rootDir: string, maxDepth: number): Promise<string> {
        const lines: string[] = [];
        const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
            if (depth <= 0 || lines.length >= MAX_DIR_LIST_FILES) return;
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                const filtered = entries.filter(e =>
                    !e.name.startsWith('.') && e.name !== 'node_modules'
                );
                for (let i = 0; i < filtered.length && lines.length < MAX_DIR_LIST_FILES; i++) {
                    const entry = filtered[i]!;
                    const isLast = i === filtered.length - 1;
                    lines.push(`${prefix}${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
                    if (entry.isDirectory()) {
                        await walk(
                            path.join(dir, entry.name),
                            depth - 1,
                            prefix + (isLast ? '    ' : '│   ')
                        );
                    }
                }
            } catch {
                // Unreadable directory — skip
            }
        };

        await walk(rootDir, maxDepth, '');
        return lines.join('\n') || '(empty directory)';
    }

    // ── Verification ─────────────────────────────────────────────────────────

    private async verifyAgentFindings(
        findings: AggregatorOutput['findings'],
        repositoryRoot: string,
        options: { degraded: boolean; deterministicIssues: SecurityIssue[] },
    ): Promise<SecurityIssue[]> {
        const deterministicIds = new Set(options.deterministicIssues.map(i => i.ruleId));
        const verifiedIssues: SecurityIssue[] = [];

        for (const finding of findings) {
            const resolvedPath = path.isAbsolute(finding.filePath)
                ? finding.filePath
                : path.join(repositoryRoot, finding.filePath);

            const verification = await this.verifyFindingLocation(resolvedPath, finding.line, finding.evidence);
            if (verification.status === 'drop') continue;

            const relatedIssueIds = Array.from(new Set([
                ...(finding.linkedDeterministicFindingIds || []),
                ...this.matchDeterministicIssueIds(finding, options.deterministicIssues),
            ]));
            const groundedByDeterministicFindings = finding.groundedByDeterministicFindings
                || relatedIssueIds.some(id => deterministicIds.has(id));

            verifiedIssues.push({
                ruleId: `agent-review.${this.slugify(finding.title)}`,
                title: finding.title,
                description: `${finding.description}\n\nEvidence: ${finding.evidence}\nRemediation: ${finding.remediation}`,
                severity: finding.severity as Severity,
                filePath: resolvedPath,
                line: finding.line ?? 1,
                source: `agent-review:${finding.sourceRoles.join(', ')}`,
                confidence: finding.confidence,
                sourceType: groundedByDeterministicFindings ? 'agent-grounded' : 'agent-only',
                groundedByDeterministicFindings,
                verificationStatus: verification.status === 'verified' ? 'verified' : 'unverified',
                backend: 'in-process',
                sourceRoles: finding.sourceRoles,
                relatedIssueIds,
                degraded: options.degraded || verification.status === 'unverified',
            });
        }

        return verifiedIssues;
    }

    private async verifyFindingLocation(
        filePath: string,
        line: number | undefined,
        evidence: string,
    ): Promise<{ status: 'verified' | 'unverified' | 'drop' }> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/);
            const targetLine = Math.max(1, line ?? 1);
            if (targetLine > lines.length) return { status: 'drop' };

            const nearbyText = lines
                .slice(Math.max(0, targetLine - 3), Math.min(lines.length, targetLine + 2))
                .join('\n');
            const normalizedEvidence = this.normalizeText(evidence);
            if (!normalizedEvidence) return { status: 'unverified' };

            return this.normalizeText(nearbyText).includes(normalizedEvidence)
                ? { status: 'verified' }
                : { status: 'unverified' };
        } catch {
            return { status: 'drop' };
        }
    }

    private matchDeterministicIssueIds(
        finding: AggregatorOutput['findings'][number],
        deterministicIssues: SecurityIssue[],
    ): string[] {
        return deterministicIssues
            .filter(issue =>
                issue.filePath === finding.filePath
                && issue.line === (finding.line ?? issue.line)
                && (issue.ruleId === finding.title || issue.title === finding.title)
            )
            .map(issue => issue.ruleId);
    }

    // ── Utilities ────────────────────────────────────────────────────────────

    private async runWithConcurrency<TInput, TOutput>(
        items: TInput[],
        concurrency: number,
        worker: (item: TInput, index: number) => Promise<TOutput>,
    ): Promise<TOutput[]> {
        const results = new Array<TOutput>(items.length);
        const executing = new Set<Promise<void>>();

        for (let i = 0; i < items.length; i++) {
            if (i > 0 && this.delayBetweenCallsMs > 0) {
                await new Promise(resolve => setTimeout(resolve, this.delayBetweenCallsMs));
            }

            while (executing.size >= concurrency) {
                await Promise.race(executing);
            }

            const p = worker(items[i]!, i).then(result => { results[i] = result; });
            executing.add(p);
            p.finally(() => executing.delete(p));
        }

        await Promise.all(executing);
        return results;
    }

    private summarizeDeterministicIssues(issues: SecurityIssue[]): string {
        if (issues.length === 0) return 'No deterministic findings were provided.';
        return issues.slice(0, 20).map((issue, i) =>
            `${i + 1}. [${issue.severity}] ${issue.ruleId} at ${issue.filePath}:${issue.line} - ${issue.description}`
        ).join('\n');
    }

    private reportStatus(context: SecurityScanContext, update: SecurityScanStatusUpdate): void {
        context.reportStatus?.({ ...update, scanner: update.scanner || this.name });
    }

    private detectRepositoryRoot(paths: string[]): string {
        if (paths.length === 0) return process.cwd();
        if (paths.length === 1) return path.dirname(paths[0]!);
        const segments = paths.map(v => path.resolve(v).split(path.sep));
        const first = segments[0]!;
        let commonLength = first.length;
        for (const candidate of segments.slice(1)) {
            commonLength = Math.min(commonLength, candidate.length);
            for (let i = 0; i < commonLength; i++) {
                if (candidate[i] !== first[i]) { commonLength = i; break; }
            }
        }
        const resolved = first.slice(0, commonLength).join(path.sep);
        return resolved || path.dirname(paths[0]!);
    }

    private getEffectiveScanPaths(
        paths: string[],
        changedFiles: string[],
        repositoryRoot: string,
    ): string[] {
        const changedAbs = changedFiles
            .map(f => path.isAbsolute(f) ? f : path.join(repositoryRoot, f))
            .filter(Boolean);
        switch (this.reviewScope) {
            case 'changed-files': return changedAbs.length > 0 ? changedAbs : paths;
            case 'both': return Array.from(new Set([...paths, ...changedAbs]));
            case 'workspace':
            default:
                return paths;
        }
    }

    private async detectChangedFiles(repositoryRoot: string): Promise<string[]> {
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            const { stdout } = await execAsync('git diff --name-only HEAD --', { cwd: repositoryRoot });
            return stdout.split('\n').map((line: string) => line.trim()).filter(Boolean);
        } catch {
            return [];
        }
    }

    private normalizeText(value: string): string {
        return value.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    private slugify(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    }
}
