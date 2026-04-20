import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { z } from 'zod';

import type { ScanResult, SecurityIssue, SecurityScanContext, SecurityScanner, Severity } from '../ports';
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
}

interface BackendReadinessState {
    ready: boolean;
    diagnostics?: {
        category: 'auth' | 'network' | 'filesystem' | 'unknown';
        hint: string;
    };
}

export interface CliAgentReviewScannerOptions {
    execFn?: typeof exec;
    maxSpecialists?: number;
    specialistConcurrency?: number;
    reviewScope?: 'workspace' | 'changed-files' | 'both';
    preferredBackend?: AgentBackendId;
    backends?: Partial<Record<AgentBackendId, Partial<AgentBackendConfig>>>;
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
    })),
});

type PlannerOutput = z.infer<typeof plannerSchema>;
type SpecialistOutput = z.infer<typeof specialistSchema>;
type AggregatorOutput = z.infer<typeof aggregatorSchema>;

export class CliAgentReviewScanner implements SecurityScanner {
    readonly name = 'agent-review';
    readonly scanKind = 'agent' as const;
    private readonly execFn: typeof exec;
    private readonly maxSpecialists: number;
    private readonly specialistConcurrency: number;
    private readonly reviewScope: 'workspace' | 'changed-files' | 'both';
    private readonly preferredBackend: AgentBackendId | undefined;
    private readonly backends: Record<AgentBackendId, AgentBackendConfig>;
    private readonly readinessCache = new Map<AgentBackendId, BackendReadinessState>();

    constructor(options: CliAgentReviewScannerOptions = {}) {
        this.execFn = options.execFn || exec;
        this.maxSpecialists = Math.max(1, options.maxSpecialists ?? 6);
        this.specialistConcurrency = Math.max(1, options.specialistConcurrency ?? 3);
        this.reviewScope = options.reviewScope ?? 'both';
        this.preferredBackend = options.preferredBackend;
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

    private get execAsync() {
        return promisify(this.execFn);
    }

    getSupportedExtensions(): string[] {
        return ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php', '.json', '.yaml', '.yml', '.toml'];
    }

    async isAvailable(): Promise<boolean> {
        const available = await this.getAvailableBackends();
        logger.info('Agent review backend availability checked', {
            availableBackends: available.map(item => item.id),
        });
        return available.length > 0;
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
        logger.info('Running agent review planner', {
            backend: leadBackend.id,
            maxSpecialists: this.maxSpecialists,
        });
        const plannerRaw = await this.runBackend(leadBackend, plannerPrompt, repositoryRoot);
        const planner = plannerSchema.parse(this.extractJson(plannerRaw));
        const specialists = planner.specialists.slice(0, this.maxSpecialists);
        logger.info('Agent review planner completed', {
            backend: leadBackend.id,
            specialistCount: specialists.length,
            specialistNames: specialists.map(item => item.name),
        });

        const specialistResults = await Promise.all(
            await this.runWithConcurrency(
                specialists,
                this.specialistConcurrency,
                (specialist, index) => this.runSpecialist(
                    specialist,
                    availableBackends[index % availableBackends.length]!,
                    {
                        repositoryRoot,
                        deterministicIssues,
                        changedFiles,
                        repoSummary: planner.repoSummary,
                    }
                )
            )
        );
        logger.info('Agent review specialists completed', {
            specialistCount: specialistResults.length,
            findingsCount: specialistResults.reduce((count, item) => count + item.findings.length, 0),
        });

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

        logger.info('Running agent review aggregator', {
            backend: leadBackend.id,
            rawFindingCount: rawAgentFindings.length,
        });
        const aggregatorRaw = await this.runBackend(leadBackend, aggregatorPrompt, repositoryRoot);
        const aggregated = aggregatorSchema.parse(this.extractJson(aggregatorRaw));
        logger.info('Agent review aggregation completed', {
            backend: leadBackend.id,
            finalFindingCount: aggregated.findings.length,
        });

        return {
            issues: aggregated.findings.map((finding) => this.toIssue(finding)),
            scannedFiles: paths,
            scanDurationMs: Date.now() - startTime,
            scannerInfo: `AI Agent Review (${availableBackends.map(b => b.id).join(', ')})`,
        };
    }

    private async runWithConcurrency<TInput, TOutput>(
        items: TInput[],
        concurrency: number,
        worker: (item: TInput, index: number) => Promise<TOutput>,
    ): Promise<TOutput[]> {
        const results = new Array<TOutput>(items.length);
        let nextIndex = 0;

        const runWorker = async () => {
            while (nextIndex < items.length) {
                const currentIndex = nextIndex++;
                results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
        );

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
        }
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
        const raw = await this.runBackend(backend, prompt, context.repositoryRoot);
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
            const versionCommand = `${config.binaryPath} --version`;
            await this.execAsync(versionCommand, {
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
            this.readinessCache.set(id, state);
            if (!ready) {
                logger.warn('Agent review backend failed readiness probe', { backend: id });
            }
            return state;
        } catch (error) {
            const diagnostics = this.classifyBackendFailure(id, error as ExecLikeError);
            logger.warn('Agent review backend failed readiness probe', {
                backend: id,
                diagnostics,
            });
            const state: BackendReadinessState = { ready: false, diagnostics };
            this.readinessCache.set(id, state);
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
            case 'opencode':
                return this.runBackend(backend, prompt, cwd, {
                    isReadinessProbe: true,
                    expectsJsonObject: true,
                });
            case 'gemini':
                return this.runGeminiReadinessProbe(backend, cwd);
        }
    }

    private async runGeminiReadinessProbe(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        cwd: string,
    ): Promise<string> {
        const command = `${backend.config.binaryPath} --approval-mode plan --output-format json -p ${JSON.stringify('Return ONLY this exact JSON: {"ready":true}')}`;

        try {
            const { stdout } = await this.execAsync(command, {
                cwd,
                maxBuffer: 10 * 1024 * 1024,
                env: this.buildExecEnv(backend.id),
                timeout: 15000,
            });
            return this.normalizeBackendOutput(backend.id, stdout, {
                isReadinessProbe: true,
                expectsJsonObject: true,
            });
        } catch (error) {
            throw error;
        }
    }

    private async runBackend(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        prompt: string,
        cwd: string,
        options: BackendExecutionOptions = {},
    ): Promise<string> {
        const command = this.buildBackendCommand(backend, prompt);

        try {
            const { stdout } = await this.execAsync(command, {
                cwd,
                maxBuffer: 20 * 1024 * 1024,
                env: this.buildExecEnv(backend.id),
                timeout: options.isReadinessProbe ? 15000 : undefined,
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

    private buildBackendCommand(
        backend: { id: AgentBackendId; config: AgentBackendConfig },
        prompt: string,
    ): string {
        const quotedPrompt = JSON.stringify(this.buildBackendPrompt(backend.id, prompt));

        switch (backend.id) {
            case 'codex': {
                const modelFlag = backend.config.model ? ` --model ${JSON.stringify(backend.config.model)}` : '';
                return `${backend.config.binaryPath} exec --sandbox read-only --skip-git-repo-check${modelFlag} ${quotedPrompt}`;
            }
            case 'gemini':
                return `${backend.config.binaryPath} --approval-mode plan --output-format json -p ${quotedPrompt}`;
            case 'opencode':
                return `${backend.config.binaryPath} run --print-logs --format json ${quotedPrompt}`;
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

    private buildExecEnv(backend: AgentBackendId): NodeJS.ProcessEnv {
        const env = { ...process.env };
        if (backend === 'opencode') {
            env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || '/tmp/opencode-cache';
            env.XDG_DATA_HOME = env.XDG_DATA_HOME || '/tmp/opencode-data';
            env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME || '/tmp/opencode-config';
        }
        return env;
    }

    private classifyBackendFailure(backend: AgentBackendId, error: ExecLikeError): {
        category: 'auth' | 'network' | 'filesystem' | 'unknown';
        hint: string;
    } {
        const text = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
        const normalized = text.toLowerCase();

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

        if (normalized.includes('dns error') || normalized.includes('operation not permitted') || normalized.includes('unable to connect') || normalized.includes('failed to fetch')) {
            return {
                category: 'network',
                hint: `${backend} could not reach its backend service or model registry.`,
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
            const { stdout } = await this.execAsync('git diff --name-only HEAD --', {
                cwd: repositoryRoot,
                maxBuffer: 1024 * 1024,
            });
            return stdout.split('\n').map(line => line.trim()).filter(Boolean);
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
            'Each specialist must have a unique role name, rationale, focus, file/path scope, and specific checks to perform.',
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
                }],
            }, null, 2),
        ].join('\n\n');
    }

    private toIssue(finding: AggregatorOutput['findings'][number]): SecurityIssue {
        const issue: SecurityIssue = {
            ruleId: `agent-review.${this.slugify(finding.title)}`,
            title: finding.title,
            description: `${finding.description}\n\nEvidence: ${finding.evidence}\nRemediation: ${finding.remediation}`,
            severity: this.normalizeSeverity(finding.severity),
            filePath: finding.filePath,
            line: finding.line ?? 1,
            source: `agent-review:${finding.sourceRoles.join(', ')}`,
            confidence: finding.confidence,
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
