import { exec, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
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

const logger = createLogger('CliAgentReviewScanner');

export type AgentBackendId = 'codex' | 'gemini' | 'opencode';

interface AgentBackendConfig {
    enabled: boolean;
    binaryPath: string;
    model?: string;
}

interface ExecLikeError {
    stdout?: string;
    stderr?: string;
    message?: string;
}

interface BackendExecutionOptions {
    isReadinessProbe?: boolean;
    expectsJsonObject?: boolean;
    /** Callback for each progress line emitted during execution (streaming) */
    onStderrLine?: (line: string) => void;
}

interface BackendReadinessState {
    ready: boolean;
    diagnostics?: {
        category: 'auth' | 'rate-limit' | 'network' | 'filesystem' | 'unknown';
        hint: string;
    };
}

export type AgentScanDepth = 'developer' | 'team' | 'security' | 'audit';

export function resolveScanDepthConfig(depth: AgentScanDepth): { maxSpecialists: number; concurrency: number; delayBetweenCallsMs: number; label: string } {
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

export interface CliAgentReviewScannerOptions {
    execFn?: typeof exec;
    execFileFn?: typeof execFile;
    maxSpecialists?: number;
    specialistConcurrency?: number;
    delayBetweenCallsMs?: number;
    reviewScope?: 'workspace' | 'changed-files' | 'both';
    preferredBackend?: AgentBackendId;
    backends?: Partial<Record<AgentBackendId, Partial<AgentBackendConfig>>>;
    /**
     * Called when a backend fails with a confirmed auth error.
     * Use this from the extension layer to show a VS Code notification
     * without introducing a VS Code dependency in core.
     */
    onAuthFailure?: (backend: AgentBackendId) => void;
}

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

export class CliAgentReviewScanner implements SecurityScanner {
    readonly name = 'agent-review';
    readonly scanKind = 'agent' as const;
    private readonly execFileFn: typeof execFile;
    private readonly execFn: typeof exec | undefined;
    private maxSpecialists: number;
    private specialistConcurrency: number;
    private delayBetweenCallsMs: number;
    private reviewScope: 'workspace' | 'changed-files' | 'both';
    private preferredBackend: AgentBackendId | undefined;
    private backends: Record<AgentBackendId, AgentBackendConfig>;
    private readonly onAuthFailure: ((backend: AgentBackendId) => void) | undefined;
    /**
     * Readiness cache — only stores outcomes that are stable across a session:
     *   ready: true  (including rate-limited)  → cached permanently
     *   ready: false, category filesystem/unknown-binary → cached permanently
     *   ready: false, category auth/network/unknown → NOT cached (re-probe next scan)
     */
    private readonly readinessCache = new Map<AgentBackendId, BackendReadinessState>();

    constructor(options: CliAgentReviewScannerOptions = {}) {
        this.execFn = options.execFn;
        this.execFileFn = options.execFileFn || execFile;
        this.maxSpecialists = Math.max(1, options.maxSpecialists ?? 6);
        this.specialistConcurrency = Math.max(1, options.specialistConcurrency ?? 3);
        this.delayBetweenCallsMs = Math.max(0, options.delayBetweenCallsMs ?? 0);
        this.reviewScope = options.reviewScope ?? 'both';
        this.preferredBackend = options.preferredBackend;
        this.onAuthFailure = options.onAuthFailure;
        this.backends = {
            codex: {
                enabled: true,
                binaryPath: 'codex',
                ...options.backends?.codex,
            },
            gemini: {
                enabled: true,
                binaryPath: 'gemini',
                ...options.backends?.gemini,
            },
            opencode: {
                enabled: true,
                binaryPath: 'opencode',
                ...options.backends?.opencode,
            },
        };
    }

    configure(options: CliAgentReviewScannerOptions = {}): void {
        if (options.maxSpecialists !== undefined) {
            this.maxSpecialists = Math.max(1, options.maxSpecialists);
        }
        if (options.specialistConcurrency !== undefined) {
            this.specialistConcurrency = Math.max(1, options.specialistConcurrency);
        }
        if (options.delayBetweenCallsMs !== undefined) {
            this.delayBetweenCallsMs = Math.max(0, options.delayBetweenCallsMs);
        }
        if (options.reviewScope !== undefined) {
            this.reviewScope = options.reviewScope;
        }
        if (options.preferredBackend !== undefined) {
            this.preferredBackend = options.preferredBackend;
        }
        if (options.backends) {
            this.backends = {
                codex: {
                    ...this.backends.codex,
                    ...options.backends.codex,
                },
                gemini: {
                    ...this.backends.gemini,
                    ...options.backends.gemini,
                },
                opencode: {
                    ...this.backends.opencode,
                    ...options.backends.opencode,
                },
            };
            this.readinessCache.clear();
        }
    }

    /**
     * Spawn a binary with an explicit args array, bypassing the shell entirely.
     * Using execFile instead of exec prevents shell metacharacters in prompts
     * (backticks, semicolons, $(...), etc.) from being interpreted by /bin/sh.
     */
    private execFileAsync(
        binary: string,
        args: string[],
        options: Parameters<typeof execFile>[2],
    ): Promise<{ stdout: string; stderr: string }> {
        if (this.execFn) {
            const command = this.buildLegacyShellCommand(binary, args);
            return promisify(this.execFn)(command, (options ?? {}) as any) as unknown as Promise<{ stdout: string; stderr: string }>;
        }
        return promisify(this.execFileFn)(binary, args, options ?? {}) as Promise<{ stdout: string; stderr: string }>;
    }

    private buildLegacyShellCommand(binary: string, args: string[]): string {
        return [binary, ...args.map((arg, index) => this.quoteLegacyShellArg(arg, args[index - 1]))].join(' ');
    }

    private quoteLegacyShellArg(arg: string, previousArg?: string): string {
        if (previousArg === '--model' || /\s/.test(arg)) {
            return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
        }
        return arg;
    }

    getSupportedExtensions(): string[] {
        return ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php', '.json', '.yaml', '.yml', '.toml'];
    }

    async isAvailable(): Promise<boolean> {
        // Fast path: only check if any backend binary exists on PATH.
        // The full readiness probe (invokes the AI model) runs at scan
        // time via getAvailableBackends(), not here.
        const candidates = (Object.keys(this.backends) as AgentBackendId[])
            .filter(id => this.backends[id].enabled);
        if (candidates.length === 0) return false;
        const results = await Promise.all(
            candidates.map(id => this.checkBackendAvailable(id, this.backends[id])),
        );
        const anyAvailable = results.some(Boolean);
        logger.info('Agent review binary availability checked', {
            available: anyAvailable,
        });
        return anyAvailable;
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
        const availableBackends = await this.getAvailableBackends();

        if (availableBackends.length === 0) {
            logger.warn('Skipping agent review: no CLI backends available');
            this.reportStatus(context, {
                phase: 'skipped',
                level: 'warn',
                message: 'AI review skipped because no configured CLI backends are ready.',
                degraded: true,
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: 'AI Agent Review (no backends available)',
            };
        }

        const repositoryRoot = context.repositoryRoot || this.detectRepositoryRoot(paths);
        const changedFiles = context.changedFiles || await this.detectChangedFiles(repositoryRoot);
        const effectivePaths = this.getEffectiveScanPaths(paths, changedFiles, repositoryRoot);
        const deterministicIssues = context.deterministicIssues || [];
        logger.info('Starting agent review scan', {
            repositoryRoot,
            pathCount: paths.length,
            effectivePathCount: effectivePaths.length,
            deterministicIssueCount: deterministicIssues.length,
            changedFileCount: changedFiles.length,
            availableBackends: availableBackends.map(item => item.id),
            reviewScope: this.reviewScope,
            specialistConcurrency: this.specialistConcurrency,
        });

        const plannerPrompt = this.buildPlannerPrompt({
            repositoryRoot,
            paths: effectivePaths,
            deterministicIssues,
            changedFiles,
        });

        const leadBackend = availableBackends[0]!;
        this.reportStatus(context, {
            phase: 'agent-planner',
            level: 'info',
            message: `AI review planner running with ${leadBackend.id}.`,
            backend: leadBackend.id,
        });
        logger.info('Running agent review planner', {
            backend: leadBackend.id,
            maxSpecialists: this.maxSpecialists,
        });
        let planner: PlannerOutput;
        try {
            const plannerRaw = await this.runBackend(leadBackend, plannerPrompt, repositoryRoot, {
                onStderrLine: (line) => {
                    this.reportStatus(context, {
                        phase: 'agent-planner',
                        level: 'info',
                        message: `AI review planner running with ${leadBackend.id}.`,
                        backend: leadBackend.id,
                        agentLog: line,
                    });
                },
            });
            planner = plannerSchema.parse(this.extractJson(plannerRaw));
        } catch (error) {
            logger.warn('Agent review planner failed; skipping AI review', { error: toError(error) });
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: `AI review planner failed on ${leadBackend.id}; deterministic results only.`,
                backend: leadBackend.id,
                degraded: true,
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: `AI Agent Review (${leadBackend.id} planner failed)`,
            };
        }
        const specialists = planner.specialists.slice(0, this.maxSpecialists);
        logger.info('Agent review planner completed', {
            backend: leadBackend.id,
            specialistCount: specialists.length,
            specialistNames: specialists.map(item => item.name),
        });

        if (specialists.length === 0) {
            this.reportStatus(context, {
                phase: 'skipped',
                level: 'info',
                message: 'AI review planner did not select any specialist reviewers.',
                backend: leadBackend.id,
            });
            return {
                issues: [],
                scannedFiles: paths,
                scanDurationMs: Date.now() - startTime,
                scannerInfo: `AI Agent Review (${leadBackend.id}, no specialists selected)`,
            };
        }

        this.reportStatus(context, {
            phase: 'agent-specialists',
            level: 'info',
            message: `Running ${specialists.length} AI specialist review(s).`,
            backend: leadBackend.id,
        });
        const specialistOutcomes = await this.runWithConcurrency(
            specialists,
            this.specialistConcurrency,
            (specialist, index) => this.runSpecialistSafely(
                specialist,
                availableBackends[index % availableBackends.length]!,
                {
                    repositoryRoot,
                    deterministicIssues,
                    changedFiles,
                    repoSummary: planner.repoSummary,
                },
                (line) => {
                    this.reportStatus(context, {
                        phase: 'agent-specialists',
                        level: 'info',
                        message: `Running ${specialists.length} AI specialist review(s).`,
                        backend: leadBackend.id,
                        agentLog: line,
                    });
                }
            )
        );
        const specialistResults = specialistOutcomes
            .filter((result): result is NonNullable<typeof result> => result !== null);
        const failedSpecialists = specialistOutcomes.length - specialistResults.length;
        logger.info('Agent review specialists completed', {
            specialistCount: specialistResults.length,
            findingsCount: specialistResults.reduce((count, item) => count + item.findings.length, 0),
        });
        if (failedSpecialists > 0) {
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: `${failedSpecialists} AI specialist review(s) failed; continuing with partial coverage.`,
                backend: leadBackend.id,
                degraded: true,
            });
        }

        const rawAgentFindings = specialistResults.flatMap(result => result.findings.map(finding => ({
            ...finding,
            roleName: result.roleName,
            backend: result.backend,
        })));

        const aggregatorPrompt = this.buildAggregatorPrompt({
            repoSummary: planner.repoSummary,
            deterministicIssues,
            rawAgentFindings,
        });

        let aggregatedFindings: AggregatorOutput['findings'];
        let usedFallbackAggregation = false;
        this.reportStatus(context, {
            phase: 'agent-aggregator',
            level: 'info',
            message: 'Merging AI specialist findings.',
            backend: leadBackend.id,
        });
        logger.info('Running agent review aggregator', {
            backend: leadBackend.id,
            rawFindingCount: rawAgentFindings.length,
        });
        try {
            const aggregatorRaw = await this.runBackend(leadBackend, aggregatorPrompt, repositoryRoot, {
                onStderrLine: (line) => {
                    this.reportStatus(context, {
                        phase: 'agent-aggregator',
                        level: 'info',
                        message: 'Merging AI specialist findings.',
                        backend: leadBackend.id,
                        agentLog: line,
                    });
                },
            });

            // Attempt 1: standard extraction + Zod validation.
            let aggregated: AggregatorOutput | undefined;
            try {
                aggregated = aggregatorSchema.parse(this.extractJson(aggregatorRaw));
            } catch (firstError) {
                // Attempt 2: more aggressive extraction and field normalisation.
                // Gemini may return the JSON wrapped in prose, markdown fences without
                // a language tag, or with enum values in the wrong case / line numbers
                // set to 0. Try to salvage the output before falling back entirely.
                logger.info('Agent review aggregator: standard parse failed; trying lenient extraction', {
                    backend: leadBackend.id,
                    firstError: toError(firstError),
                });
                try {
                    const extracted = this.extractJsonAggressive(aggregatorRaw);
                    const normalised = this.normalizeAggregatorFindings(extracted);
                    aggregated = aggregatorSchema.parse(normalised);
                } catch (secondError) {
                    // Both attempts failed — re-throw the original error so the outer
                    // catch logs the real root cause and activates the last-resort fallback.
                    logger.warn('Agent review aggregator: lenient extraction also failed', {
                        backend: leadBackend.id,
                        secondError: toError(secondError),
                    });
                    throw firstError;
                }
            }

            aggregatedFindings = aggregated!.findings;
            logger.info('Agent review aggregation completed', {
                backend: leadBackend.id,
                finalFindingCount: aggregated!.findings.length,
            });
        } catch (error) {
            usedFallbackAggregation = true;
            logger.warn('Agent review aggregator failed; falling back to raw specialist findings', {
                error: toError(error),
            });
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: 'AI aggregation failed; using verified specialist findings directly.',
                backend: leadBackend.id,
                degraded: true,
            });
            aggregatedFindings = rawAgentFindings.map((finding) => ({
                title: finding.title,
                description: finding.description,
                severity: finding.severity,
                confidence: finding.confidence,
                filePath: finding.filePath,
                line: finding.line,
                evidence: finding.evidence,
                remediation: finding.remediation,
                sourceRoles: [finding.roleName],
                groundedByDeterministicFindings: false,
                linkedDeterministicFindingIds: [],
            }));
        }

        this.reportStatus(context, {
            phase: 'agent-verification',
            level: 'info',
            message: 'Verifying AI findings against the current workspace state.',
            backend: leadBackend.id,
        });
        const verifiedIssues = await this.verifyAgentFindings(
            aggregatedFindings,
            repositoryRoot,
            leadBackend.id,
            {
                degraded: usedFallbackAggregation || failedSpecialists > 0,
                deterministicIssues,
            }
        );
        const verifiedCount = verifiedIssues.filter(issue => issue.verificationStatus === 'verified').length;
        const downgradedCount = verifiedIssues.filter(issue => issue.verificationStatus === 'unverified').length;
        if (downgradedCount > 0) {
            this.reportStatus(context, {
                phase: 'degraded',
                level: 'warn',
                message: `${downgradedCount} AI finding(s) could not be fully verified and were downgraded.`,
                backend: leadBackend.id,
                degraded: true,
            });
        }

        return {
            issues: verifiedIssues,
            scannedFiles: paths,
            scanDurationMs: Date.now() - startTime,
            scannerInfo: `AI Agent Review (${availableBackends.map(b => b.id).join(', ')}, verified: ${verifiedCount}, downgraded: ${downgradedCount})`,
        };
    }

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

            const p = worker(items[i]!, i).then(result => {
                results[i] = result;
            });
            executing.add(p);
            p.finally(() => executing.delete(p));
        }

        await Promise.all(executing);
        return results;
    }

    private async runSpecialist(
        specialist: PlannerOutput['specialists'][number],
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        context: {
            repositoryRoot: string;
            deterministicIssues: SecurityIssue[];
            changedFiles: string[];
            repoSummary: string;
        },
        onStderrLine?: (line: string) => void,
    ): Promise<{ roleName: string; backend: string; findings: SpecialistOutput['findings'] }> {
        logger.info('Running agent review specialist', {
            roleName: specialist.name,
            backend: backend.id,
            scopedPaths: specialist.paths,
            checkCount: specialist.checks.length,
        });
        const prompt = this.buildSpecialistPrompt({
            specialist,
            repoSummary: context.repoSummary,
            deterministicIssues: context.deterministicIssues,
            changedFiles: context.changedFiles,
        });
        const raw = await this.runBackend(backend, prompt, context.repositoryRoot,
            onStderrLine
                ? { onStderrLine: (line) => onStderrLine(`[${specialist.name}] ${line}`) }
                : {}
        );
        const parsed = specialistSchema.parse(this.extractJson(raw));
        logger.info('Agent review specialist completed', {
            roleName: specialist.name,
            backend: backend.id,
            findingCount: parsed.findings.length,
        });
        return {
            roleName: specialist.name,
            backend: backend.id,
            findings: parsed.findings,
        };
    }

    private async runSpecialistSafely(
        specialist: PlannerOutput['specialists'][number],
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        context: {
            repositoryRoot: string;
            deterministicIssues: SecurityIssue[];
            changedFiles: string[];
            repoSummary: string;
        },
        onStderrLine?: (line: string) => void,
    ): Promise<{ roleName: string; backend: string; findings: SpecialistOutput['findings'] } | null> {
        try {
            return await this.runSpecialist(specialist, backend, context, onStderrLine);
        } catch (error) {
            logger.warn('Agent review specialist failed', {
                roleName: specialist.name,
                backend: backend.id,
                error: toError(error),
            });
            return null;
        }
    }

    private reportStatus(context: SecurityScanContext, update: SecurityScanStatusUpdate): void {
        context.reportStatus?.({
            ...update,
            scanner: update.scanner || this.name,
        });
    }

    private async verifyAgentFindings(
        findings: AggregatorOutput['findings'],
        repositoryRoot: string,
        backend: AgentBackendId,
        options: {
            degraded: boolean;
            deterministicIssues: SecurityIssue[];
        },
    ): Promise<SecurityIssue[]> {
        const deterministicIds = new Set(options.deterministicIssues.map(issue => issue.ruleId));
        const verifiedIssues: SecurityIssue[] = [];

        for (const finding of findings) {
            const resolvedPath = path.isAbsolute(finding.filePath)
                ? finding.filePath
                : path.join(repositoryRoot, finding.filePath);
            const verification = await this.verifyFindingLocation(resolvedPath, finding.line, finding.evidence);
            if (verification.status === 'drop') {
                continue;
            }

            const relatedIssueIds = Array.from(new Set([
                ...(finding.linkedDeterministicFindingIds || []),
                ...this.matchDeterministicIssueIds(finding, options.deterministicIssues),
            ]));
            const groundedByDeterministicFindings = finding.groundedByDeterministicFindings
                || relatedIssueIds.some(id => deterministicIds.has(id));

            verifiedIssues.push(this.toIssue(finding, {
                backend,
                degraded: options.degraded || verification.status === 'unverified',
                filePath: resolvedPath,
                groundedByDeterministicFindings,
                relatedIssueIds,
                verificationStatus: verification.status === 'verified' ? 'verified' : 'unverified',
            }));
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
            if (targetLine > lines.length) {
                return { status: 'drop' };
            }

            const nearbyText = lines
                .slice(Math.max(0, targetLine - 3), Math.min(lines.length, targetLine + 2))
                .join('\n');
            const normalizedEvidence = this.normalizeEvidence(evidence);
            if (!normalizedEvidence) {
                return { status: 'unverified' };
            }

            if (this.normalizeEvidence(nearbyText).includes(normalizedEvidence)) {
                return { status: 'verified' };
            }

            return { status: 'unverified' };
        } catch {
            return { status: 'drop' };
        }
    }

    private normalizeEvidence(value: string): string {
        return value.toLowerCase().replace(/\s+/g, ' ').trim();
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

    private async getAvailableBackends(): Promise<Array<{ id: AgentBackendId; config: AgentBackendConfig }>> {
        const candidates = (Object.keys(this.backends) as AgentBackendId[])
            .filter(id => this.backends[id].enabled);
        const available: Array<{ id: AgentBackendId; config: AgentBackendConfig }> = [];

        for (const id of candidates) {
            const readiness = await this.checkBackendReady(id, this.backends[id]);
            if (readiness.ready) {
                available.push({ id, config: this.backends[id] });
            } else {
                logger.warn('Agent review backend unavailable', {
                    backend: id,
                    diagnostics: readiness.diagnostics,
                });
            }
        }

        if (this.preferredBackend) {
            available.sort((left, right) => {
                if (left.id === this.preferredBackend) return -1;
                if (right.id === this.preferredBackend) return 1;
                return 0;
            });
        }

        return available;
    }

    private async checkBackendAvailable(id: AgentBackendId, config: AgentBackendConfig): Promise<boolean> {
        try {
            await this.execFileAsync(config.binaryPath, ['--version'], {
                maxBuffer: 1024 * 1024,
                env: this.buildExecEnv(id),
            });
            return true;
        } catch {
            return false;
        }
    }

    private async checkBackendReady(id: AgentBackendId, config: AgentBackendConfig): Promise<BackendReadinessState> {
        if (this.readinessCache.has(id)) {
            return this.readinessCache.get(id)!;
        }

        const versionOk = await this.checkBackendAvailable(id, config);
        if (!versionOk) {
            // Binary not found — this is a permanent installation issue; cache it.
            const state: BackendReadinessState = {
                ready: false,
                diagnostics: {
                    category: 'unknown',
                    hint: `${id} is not installed or is not runnable from PATH.`,
                },
            };
            this.readinessCache.set(id, state);
            return state;
        }

        try {
            const probeOutput = await this.runBackendReadinessProbe({ id, config }, process.cwd());
            const parsed = this.extractJson(probeOutput) as { ready?: boolean };
            const ready = parsed.ready === true;
            const state: BackendReadinessState = { ready };
            // A ready-true result is stable for the session; cache it.
            if (ready) {
                this.readinessCache.set(id, state);
            } else {
                logger.warn('Agent review backend failed readiness probe', { backend: id });
                // Do not cache: we want to re-probe next time in case the environment
                // or credentials are fixed without a full reload.
            }
            return state;
        } catch (error) {
            const diagnostics = this.classifyBackendFailure(id, error as ExecLikeError);

            // Rate-limited — user IS authenticated; cache as ready.
            if (diagnostics.category === 'rate-limit') {
                logger.info('Agent review backend is rate-limited but authenticated', { backend: id });
                const state: BackendReadinessState = { ready: true, diagnostics };
                this.readinessCache.set(id, state);
                return state;
            }

            logger.warn('Agent review backend failed readiness probe', {
                backend: id,
                diagnostics,
            });

            // Auth, network, and unknown failures are transient — do not cache so
            // the next scan attempt re-probes. The binary-not-found case is handled
            // above and exits early, so 'unknown' here means an unclassified probe
            // error (e.g. timeout, unexpected output) that may not persist.
            const isTransient = (
                diagnostics.category === 'auth' ||
                diagnostics.category === 'network' ||
                diagnostics.category === 'unknown'
            );
            const state: BackendReadinessState = { ready: false, diagnostics };
            if (!isTransient) {
                this.readinessCache.set(id, state);
            }

            // Notify the extension layer so it can surface an actionable toast.
            if (diagnostics.category === 'auth') {
                this.onAuthFailure?.(id);
            }

            return state;
        }
    }

    private async runBackendReadinessProbe(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        cwd: string,
    ): Promise<string> {
        const prompt = 'Return ONLY this exact JSON: {"ready":true}';

        switch (backend.id) {
            case 'codex':
                return this.runBackend(backend, prompt, cwd, {
                    isReadinessProbe: true,
                    expectsJsonObject: true,
                });
            case 'opencode':
                // opencode's LLM round-trip is too slow for a readiness probe
                // (60 s timeout kills it before it finishes). Instead, just
                // verify the binary is runnable and trust the user has API keys
                // configured in their opencode config. Return the sentinel that
                // checkBackendReady expects.
                await this.execFileAsync(backend.config.binaryPath, ['--version'], {
                    maxBuffer: 1024 * 1024,
                    env: this.buildExecEnv(backend.id),
                    timeout: 10000,
                });
                return '{"ready":true}';
            case 'gemini':
                return this.runGeminiReadinessProbe(backend, cwd);
        }
    }

    private async runGeminiReadinessProbe(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        cwd: string,
    ): Promise<string> {
        // NOTE: We intentionally do NOT ask Gemini to return a specific JSON shape
        // and then parse it. Gemini CLI wraps its response in envelope JSON, streams
        // tokens, and adds prose that varies across versions — any of which breaks
        // extractJson. A clean process exit (no thrown error) is the only reliable
        // signal that Gemini is authenticated and reachable. We return the canonical
        // sentinel ourselves so checkBackendReady's extractJson call always succeeds.
        // Using execFile avoids /bin/sh entirely so shell metacharacters in the prompt
        // are never interpreted.
        await this.execFileAsync(
            backend.config.binaryPath,
            ['--approval-mode', 'plan', '--output-format', 'json', '-p', 'Return ONLY this exact JSON: {"ready":true}'],
            {
                cwd,
                maxBuffer: 10 * 1024 * 1024,
                env: this.buildExecEnv(backend.id),
                timeout: 60000,
            },
        );
        return '{"ready":true}';
    }

    private async runBackend(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        prompt: string,
        cwd: string,
        options: BackendExecutionOptions = {},
    ): Promise<string> {
        const { binary, args } = this.buildBackendArgs(backend, prompt);
        const env = this.buildExecEnv(backend.id);

        // opencode exposes useful CLI activity as NDJSON events on stdout.
        // Use spawn only in production so tests that inject execFn keep their
        // deterministic command mocking.
        if (backend.id === 'opencode' && options.onStderrLine && !this.execFn) {
            return this.runBackendStreaming(binary, args, Object.assign(
                { cwd, env, onStderrLine: options.onStderrLine },
                options.isReadinessProbe ? { timeout: 60000 } : {},
                { normalize: (stdout: string) => this.normalizeBackendOutput(backend.id, stdout, options) },
            ));
        }

        try {
            const { stdout } = await this.execFileAsync(binary, args, {
                cwd,
                maxBuffer: 20 * 1024 * 1024,
                env,
                timeout: options.isReadinessProbe ? 60000 : undefined,
            });
            return this.normalizeBackendOutput(backend.id, stdout, options);
        } catch (error) {
            const diagnostics = this.classifyBackendFailure(backend.id, error as ExecLikeError);
            logger.error('Agent backend execution failed', {
                backend: backend.id,
                isReadinessProbe: options.isReadinessProbe,
                diagnostics,
                error: toError(error),
            });
            throw error;
        }
    }

    /**
     * Run a backend process with streaming output capture.
     * Uses spawn instead of execFile so output can be forwarded in real-time.
     * For opencode with --format json, stdout contains NDJSON events (one JSON
     * per line) with types like:
     *   - step_start:  a processing step began
     *   - text:        text output from the model (part.text)
     *   - tool_use:    tool invocation result (part.tool, part.state.title)
     * These are converted to concise agent progress lines. The model response
     * text is accumulated from text events and returned as the final result.
     */
    private runBackendStreaming(
        binary: string,
        args: string[],
        opts: {
            cwd: string;
            env: NodeJS.ProcessEnv;
            timeout?: number;
            onStderrLine: (line: string) => void;
            normalize: (stdout: string) => string;
        },
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            let stdoutBuffer = '';
            const stderrChunks: string[] = [];
            let timedOut = false;
            let responseText = '';
            let pendingLine = '';
            let lastEmitted = '';

            const emitProgress = (line: string) => {
                const clean = line
                    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!clean) {
                    return;
                }
                // Only suppress exact consecutive duplicates (e.g. rapid flushes
                // of the same stderr line). Repeated events with the same label
                // but different positions in the stream (e.g. multiple step_start
                // events) must all be forwarded so the terminal shows live activity.
                if (clean === lastEmitted) {
                    return;
                }
                lastEmitted = clean;
                opts.onStderrLine(clean.length > 240 ? `${clean.slice(0, 237)}...` : clean);
            };

            const emitMultilineProgress = (value: string, options: { prefix?: string; maxLines?: number } = {}) => {
                const lines = value.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
                const maxLines = options.maxLines ?? 8;
                for (const line of lines.slice(0, maxLines)) {
                    emitProgress(options.prefix ? `${options.prefix}${line}` : line);
                }
                if (lines.length > maxLines) {
                    emitProgress(`${options.prefix ?? ''}... ${lines.length - maxLines} more line(s)`);
                }
            };

            const handleStdoutLine = (line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                try {
                    const event = JSON.parse(trimmed) as Record<string, any>;
                    const part = event.part && typeof event.part === 'object'
                        ? event.part as Record<string, any>
                        : {};
                    const type = String(event.type || part.type || '');

                    if (type === 'text') {
                        const text = typeof part.text === 'string' ? part.text : '';
                        if (text) {
                            responseText += text;
                            emitMultilineProgress(text, { prefix: 'assistant: ', maxLines: 12 });
                        }
                        return;
                    }

                    if (type === 'tool_use' || type === 'tool' || type === 'tool-call') {
                        const tool = String(part.tool || part.name || part.id || 'tool');
                        const state = part.state && typeof part.state === 'object'
                            ? part.state as Record<string, any>
                            : {};
                        const input = state.input && typeof state.input === 'object'
                            ? state.input as Record<string, any>
                            : {};
                        const title = String(state.title || part.title || input.description || part.description || '').trim();
                        const status = typeof state.status === 'string' ? state.status : '';
                        const command = typeof input.command === 'string' ? input.command : '';
                        const output = typeof state.output === 'string'
                            ? state.output
                            : typeof state.metadata?.output === 'string'
                                ? state.metadata.output
                                : '';

                        emitProgress(title ? `${tool}: ${title}${status ? ` (${status})` : ''}` : `${tool}${status ? ` (${status})` : ''}`);
                        if (command) {
                            emitProgress(`$ ${command}`);
                        }
                        if (output) {
                            emitMultilineProgress(output, { prefix: '  ', maxLines: 12 });
                        }
                        return;
                    }

                    if (type === 'step_start' || type === 'step-start') {
                        emitProgress('opencode: thinking');
                        return;
                    }

                    if (type === 'step_finish' || type === 'step-finish') {
                        const total = part.tokens?.total;
                        const reason = typeof part.reason === 'string' ? part.reason : 'complete';
                        emitProgress(typeof total === 'number' ? `opencode: ${reason} (${total} tokens)` : `opencode: ${reason}`);
                        return;
                    }
                } catch {
                    emitProgress(trimmed);
                }
            };

            const child = spawn(binary, args, {
                cwd: opts.cwd,
                env: opts.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let timer: ReturnType<typeof setTimeout> | undefined;
            if (opts.timeout && opts.timeout > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGTERM');
                }, opts.timeout);
            }

            child.stdout!.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdoutBuffer += chunk;
                pendingLine += chunk;
                const lines = pendingLine.split('\n');
                pendingLine = lines.pop() ?? '';
                lines.forEach(handleStdoutLine);
            });

            child.stderr!.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderrChunks.push(chunk);
                const lines = chunk.split('\n').filter(Boolean);
                for (const raw of lines) {
                    emitProgress(raw);
                }
            });

            const cleanup = () => {
                if (timer) clearTimeout(timer);
            };

            child.on('close', (code) => {
                cleanup();
                if (pendingLine.trim()) {
                    handleStdoutLine(pendingLine);
                }
                if (timedOut || code !== 0) {
                    const stderr = stderrChunks.join('').trim();
                    const err = new Error(
                        timedOut
                            ? `Process timed out after ${opts.timeout}ms`
                            : `Process exited with code ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`
                    );
                    (err as ExecLikeError).stdout = stdoutBuffer;
                    (err as ExecLikeError).stderr = stderr;
                    reject(err);
                } else {
                    resolve(opts.normalize(responseText || stdoutBuffer));
                }
            });

            child.on('error', (err) => {
                cleanup();
                reject(err);
            });
        });
    }

    /**
     * Build the binary path and explicit args array for a backend call.
     * Returns {binary, args} so execFile can spawn the process directly
     * without going through a shell — preventing shell metacharacters in
     * prompts (backticks, semicolons, $(...)) from being interpreted.
     */
    private buildBackendArgs(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        prompt: string,
    ): { binary: string; args: string[] } {
        const builtPrompt = this.buildBackendPrompt(backend.id, prompt);

        switch (backend.id) {
            case 'codex': {
                const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'];
                if (backend.config.model) {
                    args.push('--model', backend.config.model);
                }
                args.push(builtPrompt);
                return { binary: backend.config.binaryPath, args };
            }
            case 'gemini':
                return {
                    binary: backend.config.binaryPath,
                    args: ['--approval-mode', 'plan', '--output-format', 'json', '-p', builtPrompt],
                };
            case 'opencode':
                return {
                    binary: backend.config.binaryPath,
                    args: ['run', '--format', 'json', builtPrompt],
                };
        }
    }

    private buildBackendPrompt(backend: AgentBackendId, prompt: string): string {
        if (backend === 'codex') {
            return [
                'You are BackBrain\'s security scanning agent.',
                'Operate strictly in read-only mode.',
                'Return only the requested JSON object.',
                'Do not wrap JSON in markdown fences.',
                prompt,
            ].join('\n\n');
        }

        return prompt;
    }

    private normalizeBackendOutput(
        backend: AgentBackendId,
        output: string,
        options: BackendExecutionOptions,
    ): string {
        const trimmed = output.trim();
        if (!trimmed) {
            return trimmed;
        }

        if (backend === 'opencode') {
            const textOutput = this.extractOpencodeTextOutput(trimmed);
            if (textOutput) {
                return textOutput;
            }
        }

        if (backend === 'codex' && options.expectsJsonObject) {
            const jsonMatch = trimmed.match(/\{[\s\S]*\}$/);
            if (jsonMatch) {
                return jsonMatch[0];
            }
        }

        if (backend === 'gemini') {
            try {
                const envelope = JSON.parse(trimmed) as { response?: unknown };
                if (typeof envelope.response === 'string') {
                    return envelope.response.trim();
                }
                if (envelope.response && typeof envelope.response === 'object') {
                    return JSON.stringify(envelope.response);
                }
            } catch {
                // Fall through and let extractJson handle raw output.
            }
        }

        return trimmed;
    }

    private extractOpencodeTextOutput(output: string): string | undefined {
        const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) {
            return undefined;
        }

        const textParts: string[] = [];
        let parsedEventCount = 0;
        for (const line of lines) {
            try {
                const event = JSON.parse(line) as { type?: unknown; part?: { type?: unknown; text?: unknown } };
                const type = String(event.type || event.part?.type || '');
                if (!type) {
                    continue;
                }
                parsedEventCount += 1;
                if (type === 'text' && typeof event.part?.text === 'string') {
                    textParts.push(event.part.text);
                }
            } catch {
                return undefined;
            }
        }

        return parsedEventCount > 0 && textParts.length > 0
            ? textParts.join('')
            : undefined;
    }

    private extractJson(output: string): unknown {
        const trimmed = output.trim();
        if (!trimmed) {
            throw new Error('AI scanner returned empty output');
        }

        try {
            return JSON.parse(trimmed);
        } catch {
            const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
            if (fenced?.[1]) {
                return JSON.parse(fenced[1]);
            }

            const firstBrace = trimmed.indexOf('{');
            const lastBrace = trimmed.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) {
                return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            }

            throw new Error('Unable to extract valid JSON from AI scanner output');
        }
    }

    /**
     * More aggressive JSON extraction for the aggregator output.
     *
     * `extractJson` already handles plain JSON, fenced JSON, and brace-extraction.
     * This helper goes further: it strips markdown fences without a language tag,
     * searches for the `"findings"` key to locate the correct outer object boundary,
     * and handles cases where Gemini prefixes the JSON with prose.
     */
    private extractJsonAggressive(raw: string): unknown {
        const text = raw.trim();

        // Strategy 1: markdown fence with or without language tag.
        const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            const inner = fenced[1].trim();
            try { return JSON.parse(inner); } catch { /* fall through */ }
            const fb = inner.indexOf('{');
            const lb = inner.lastIndexOf('}');
            if (fb >= 0 && lb > fb) {
                try { return JSON.parse(inner.slice(fb, lb + 1)); } catch { /* fall through */ }
            }
        }

        // Strategy 2: locate the outer object by finding the `"findings"` key and
        // walking back to the enclosing `{`.
        const findingsIdx = text.indexOf('"findings"');
        if (findingsIdx >= 0) {
            const openBrace = text.lastIndexOf('{', findingsIdx);
            const closeBrace = text.lastIndexOf('}');
            if (openBrace >= 0 && closeBrace > openBrace) {
                try { return JSON.parse(text.slice(openBrace, closeBrace + 1)); } catch { /* fall through */ }
            }
        }

        throw new Error('extractJsonAggressive: no valid aggregator JSON found in output');
    }

    /**
     * Normalise a raw aggregator payload so it survives Zod validation.
     *
     * Gemini occasionally returns:
     *   - severity / confidence values in UPPER_CASE or with minor variations
     *   - line numbers of 0 or negative (invalid for Zod's `.positive()`)
     *   - non-array values for array fields
     *
     * This method mutates-then-returns the object so the Zod parse that follows
     * can succeed without schema relaxation.
     */
    private normalizeAggregatorFindings(extracted: unknown): unknown {
        if (!extracted || typeof extracted !== 'object') {
            return extracted;
        }

        const obj = extracted as Record<string, unknown>;
        if (!Array.isArray(obj.findings)) {
            return extracted;
        }

        const SEVERITY_MAP: Record<string, string> = {
            error: 'high', err: 'high',
            warn: 'medium', warning: 'medium',
        };

        obj.findings = obj.findings.map((f: unknown) => {
            if (!f || typeof f !== 'object') return f;
            const finding = { ...(f as Record<string, unknown>) };

            // severity → lowercase, map known aliases
            if (typeof finding.severity === 'string') {
                const lower = finding.severity.toLowerCase();
                finding.severity = SEVERITY_MAP[lower] ?? lower;
            }

            // confidence → lowercase
            if (typeof finding.confidence === 'string') {
                finding.confidence = finding.confidence.toLowerCase();
            }

            // line must be a positive integer or absent
            if (finding.line !== undefined) {
                const n = Number(finding.line);
                if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
                    delete finding.line;
                } else {
                    finding.line = n;
                }
            }

            // sourceRoles → always an array
            if (!Array.isArray(finding.sourceRoles)) {
                finding.sourceRoles = finding.sourceRoles
                    ? [String(finding.sourceRoles)]
                    : [];
            }

            // linkedDeterministicFindingIds → always an array
            if (!Array.isArray(finding.linkedDeterministicFindingIds)) {
                finding.linkedDeterministicFindingIds = [];
            }

            return finding;
        });

        return obj;
    }

    private buildExecEnv(backend: AgentBackendId): NodeJS.ProcessEnv {
        // VS Code's extension host can strip or corrupt HOME, PATH, and XDG_*
        // variables. Gemini CLI (and others) rely on these to locate credentials
        // and runtime state. Resolve them defensively before spawning any child
        // process so the binary can always find its auth files.
        const home = process.env.HOME || os.homedir();
        
        // Defensively build the PATH environment variable. Extension hosts on macOS
        // may strip standard bin paths (like /usr/local/bin and /opt/homebrew/bin)
        // when launched from a GUI/Launchpad.
        const defaultPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
        if (os.platform() === 'darwin') {
            defaultPaths.unshift('/opt/homebrew/bin');
        }
        const currentPath = process.env.PATH || '';
        const pathSeparator = os.platform() === 'win32' ? ';' : ':';
        const combinedPaths = Array.from(new Set([
            ...currentPath.split(pathSeparator),
            ...defaultPaths
        ])).filter(Boolean).join(pathSeparator);

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: home,
            PATH: combinedPaths,
            // Gemini CLI resolves credentials via $XDG_CONFIG_HOME/gemini/
            // (falls back to $HOME/.config/gemini/ when the var is absent, but
            // only if HOME itself is correct — set both to be safe).
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        };

        if (backend === 'opencode') {
            env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || path.join(home, '.cache');
            env.XDG_DATA_HOME  = env.XDG_DATA_HOME  || path.join(home, '.local', 'share');
        }

        return env;
    }

    private classifyBackendFailure(backend: AgentBackendId, error: ExecLikeError): {
        category: 'auth' | 'rate-limit' | 'network' | 'filesystem' | 'unknown';
        hint: string;
    } {
        const text = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
        const normalized = text.toLowerCase();

        // Rate-limit / capacity errors — user IS authenticated, just throttled
        if (
            normalized.includes('429') ||
            normalized.includes('rate_limit') ||
            normalized.includes('ratelimitexceeded') ||
            normalized.includes('resource_exhausted') ||
            normalized.includes('model_capacity_exhausted') ||
            normalized.includes('no capacity available') ||
            normalized.includes('quota')
        ) {
            return {
                category: 'rate-limit',
                hint: `${backend} is authenticated but temporarily rate-limited. It will retry automatically.`,
            };
        }

        if (
            normalized.includes('authentication page') ||
            normalized.includes('api key expired') ||
            normalized.includes('api_key_invalid') ||
            normalized.includes('insufficient credits') ||
            normalized.includes("you've hit your usage limit") ||
            normalized.includes('loaded cached credentials') && normalized.includes('login') ||
            normalized.includes('unauthenticated')
        ) {
            return {
                category: 'auth',
                hint: `${backend} is installed but not authenticated or funded for headless review.`,
            };
        }

        if (normalized.includes('dns error') || normalized.includes('operation not permitted') || normalized.includes('unable to connect') || normalized.includes('failed to fetch') || normalized.includes('timed out') || normalized.includes('timeout')) {
            return {
                category: 'network',
                hint: `${backend} could not reach its backend service or model registry (likely a network issue or timeout).`,
            };
        }

        if (normalized.includes('read-only file system') || normalized.includes('unable to open database file') || normalized.includes('mkdir')) {
            return {
                category: 'filesystem',
                hint: `${backend} could not initialize local runtime state. Check writable cache/data directories.`,
            };
        }

        if (normalized.includes('invalid values:') || normalized.includes('choices:') || normalized.includes('usage: gemini')) {
            return {
                category: 'unknown',
                hint: `${backend} CLI arguments are incompatible with the installed CLI version.`,
            };
        }

        return {
            category: 'unknown',
            hint: `${backend} failed for an unclassified reason. Inspect stderr/stdout for details.`,
        };
    }

    private detectRepositoryRoot(paths: string[]): string {
        if (paths.length === 0) {
            return process.cwd();
        }

        if (paths.length === 1) {
            return path.dirname(paths[0]!);
        }

        const segments = paths.map(value => path.resolve(value).split(path.sep));
        const first = segments[0]!;
        let commonLength = first.length;
        for (const candidate of segments.slice(1)) {
            commonLength = Math.min(commonLength, candidate.length);
            for (let index = 0; index < commonLength; index++) {
                if (candidate[index] !== first[index]) {
                    commonLength = index;
                    break;
                }
            }
        }

        const resolved = first.slice(0, commonLength).join(path.sep);
        return resolved || path.dirname(paths[0]!);
    }

    private getEffectiveScanPaths(paths: string[], changedFiles: string[], repositoryRoot: string): string[] {
        const changedAbsolutePaths = changedFiles
            .map(file => path.isAbsolute(file) ? file : path.join(repositoryRoot, file))
            .filter(Boolean);

        switch (this.reviewScope) {
            case 'changed-files':
                return changedAbsolutePaths.length > 0 ? changedAbsolutePaths : paths;
            case 'both':
                return Array.from(new Set([...paths, ...changedAbsolutePaths]));
            case 'workspace':
            default:
                return paths;
        }
    }

    private async detectChangedFiles(repositoryRoot: string): Promise<string[]> {
        try {
            const { stdout } = await this.execFileAsync('git', ['diff', '--name-only', 'HEAD', '--'], {
                cwd: repositoryRoot,
                maxBuffer: 1024 * 1024,
            });
            return stdout.split('\n').map((line: string) => line.trim()).filter(Boolean);
        } catch {
            return [];
        }
    }

    private summarizeDeterministicIssues(issues: SecurityIssue[]): string {
        if (issues.length === 0) {
            return 'No deterministic findings were provided.';
        }

        return issues.slice(0, 20).map((issue, index) =>
            `${index + 1}. [${issue.severity}] ${issue.ruleId} at ${issue.filePath}:${issue.line} - ${issue.description}`
        ).join('\n');
    }

    private buildPlannerPrompt(input: {
        repositoryRoot: string;
        paths: string[];
        deterministicIssues: SecurityIssue[];
        changedFiles: string[];
    }): string {
        return [
            'You are the lead security planning agent for a codebase review.',
            'Inspect the repository in read-only mode. You may use safe local commands for discovery, but do not modify files.',
            `Repository root: ${input.repositoryRoot}`,
            `Requested scan paths: ${input.paths.join(', ')}`,
            `Changed files: ${input.changedFiles.join(', ') || 'none detected'}`,
            'Deterministic findings:',
            this.summarizeDeterministicIssues(input.deterministicIssues),
            `Decide dynamically which specialist review agents are needed for this codebase. Emit at most ${this.maxSpecialists} specialists.`,
            'Each specialist must have a unique stable role name, rationale, focus, file/path scope, and specific checks to perform.',
            'Prefer changed files and requested scan paths over unrelated repository areas.',
            'Return ONLY valid JSON with this shape:',
            JSON.stringify({
                repoSummary: 'short repository summary',
                specialists: [{
                    name: 'freeform role name',
                    rationale: 'why this specialist is needed',
                    focus: 'what this specialist should review',
                    paths: ['relative/or/absolute/path'],
                    checks: ['specific concern to inspect'],
                    relevantFindingIds: ['optional-finding-id'],
                }],
            }, null, 2),
        ].join('\n\n');
    }

    private buildSpecialistPrompt(input: {
        specialist: PlannerOutput['specialists'][number];
        repoSummary: string;
        deterministicIssues: SecurityIssue[];
        changedFiles: string[];
    }): string {
        const relevantIds = new Set(input.specialist.relevantFindingIds || []);
        const relevantFindings = input.deterministicIssues.filter(issue =>
            relevantIds.size === 0 || relevantIds.has(issue.ruleId)
        );

        return [
            `You are a specialist security reviewer named "${input.specialist.name}".`,
            'Operate in read-only mode. You may use safe local commands for discovery, but do not edit files.',
            `Repository summary: ${input.repoSummary}`,
            `Assigned focus: ${input.specialist.focus}`,
            `Rationale: ${input.specialist.rationale}`,
            `Scope paths: ${input.specialist.paths.join(', ') || 'use your judgement within the requested scan area'}`,
            `Changed files: ${input.changedFiles.join(', ') || 'none detected'}`,
            'Checks to perform:',
            input.specialist.checks.map((check, index) => `${index + 1}. ${check}`).join('\n'),
            'Relevant deterministic findings:',
            this.summarizeDeterministicIssues(relevantFindings),
            'Every finding must cite exact code evidence from the file and include the most specific line number you can justify.',
            'Return ONLY valid JSON with this shape:',
            JSON.stringify({
                findings: [{
                    title: 'finding title',
                    description: 'clear description',
                    severity: 'high',
                    confidence: 'medium',
                    filePath: 'path/to/file',
                    line: 1,
                    evidence: 'concrete code evidence',
                    remediation: 'what to change',
                }],
            }, null, 2),
            'Do not include speculative findings without concrete code evidence.',
        ].join('\n\n');
    }

    private buildAggregatorPrompt(input: {
        repoSummary: string;
        deterministicIssues: SecurityIssue[];
        rawAgentFindings: Array<SpecialistOutput['findings'][number] & { roleName: string; backend: string }>;
    }): string {
        return [
            'You are the final security finding aggregator.',
            'Merge duplicates, prefer deterministic findings when they cover the same issue, and drop speculative or weak agent findings.',
            'Only keep findings with concrete code evidence, and indicate whether each finding is grounded in deterministic findings.',
            `Repository summary: ${input.repoSummary}`,
            'Deterministic findings:',
            this.summarizeDeterministicIssues(input.deterministicIssues),
            'Agent findings:',
            JSON.stringify(input.rawAgentFindings, null, 2),
            'Return ONLY valid JSON with this shape:',
            JSON.stringify({
                findings: [{
                    title: 'merged finding title',
                    description: 'final description',
                    severity: 'high',
                    confidence: 'medium',
                    filePath: 'path/to/file',
                    line: 1,
                    evidence: 'merged evidence summary',
                    remediation: 'recommended remediation',
                    sourceRoles: ['role name'],
                    groundedByDeterministicFindings: true,
                    linkedDeterministicFindingIds: ['det.rule.id'],
                }],
            }, null, 2),
        ].join('\n\n');
    }

    private toIssue(
        finding: AggregatorOutput['findings'][number],
        options: {
            backend: AgentBackendId;
            degraded: boolean;
            filePath: string;
            groundedByDeterministicFindings: boolean;
            relatedIssueIds: string[];
            verificationStatus: 'verified' | 'unverified';
        },
    ): SecurityIssue {
        const issue: SecurityIssue = {
            ruleId: `agent-review.${this.slugify(finding.title)}`,
            title: finding.title,
            description: `${finding.description}\n\nEvidence: ${finding.evidence}\nRemediation: ${finding.remediation}`,
            severity: this.normalizeSeverity(finding.severity),
            filePath: options.filePath,
            line: finding.line ?? 1,
            source: `agent-review:${finding.sourceRoles.join(', ')}`,
            confidence: finding.confidence,
            sourceType: options.groundedByDeterministicFindings ? 'agent-grounded' : 'agent-only',
            groundedByDeterministicFindings: options.groundedByDeterministicFindings,
            verificationStatus: options.verificationStatus,
            backend: options.backend,
            sourceRoles: finding.sourceRoles,
            relatedIssueIds: options.relatedIssueIds,
            degraded: options.degraded,
        };
        return issue;
    }

    private normalizeSeverity(value: Severity): Severity {
        return value;
    }

    private slugify(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    }
}
