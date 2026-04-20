import { beforeEach, describe, expect, it } from 'bun:test';
import { promisify } from 'util';

import { CliAgentReviewScanner } from '../../packages/core/src/adapters/cli-agent-review-scanner';
import type { SecurityIssue } from '../../packages/core/src/ports';

function createExecMock() {
    const calls: string[] = [];
    let codexExecCount = 0;

    const execMock = (cmd: string, options: any, callback: any) => {
        if (typeof options === 'function') {
            callback = options;
        }

        calls.push(cmd);

        if (cmd === 'codex --version') {
            callback(null, '1.0.0', '');
            return { on: () => { } };
        }

        if (cmd.includes('codex exec')) {
            codexExecCount += 1;

            if (codexExecCount === 1) {
                callback(null, JSON.stringify({ ready: true }), '');
                return { on: () => { } };
            }

            if (codexExecCount === 2) {
                callback(null, JSON.stringify({
                    repoSummary: 'Flask app with auth and persistence concerns',
                    specialists: [
                        {
                            name: 'auth-flow-reviewer',
                            rationale: 'Authentication logic is present',
                            focus: 'Review auth and authorization boundaries',
                            paths: ['/repo/app.py'],
                            checks: ['check auth flows', 'check privilege escalation'],
                            relevantFindingIds: ['semgrep.auth'],
                        },
                    ],
                }), '');
                return { on: () => { } };
            }

            if (codexExecCount === 3) {
                callback(null, JSON.stringify({
                    findings: [
                        {
                            title: 'Missing authorization check',
                            description: 'User can access admin endpoint without role verification.',
                            severity: 'high',
                            confidence: 'medium',
                            filePath: '/repo/app.py',
                            line: 24,
                            evidence: 'Route handler does not enforce admin role.',
                            remediation: 'Add explicit role enforcement before serving admin data.',
                        },
                    ],
                }), '');
                return { on: () => { } };
            }

            callback(null, JSON.stringify({
                findings: [
                    {
                        title: 'Missing authorization check',
                        description: 'User can access admin endpoint without role verification.',
                        severity: 'high',
                        confidence: 'medium',
                        filePath: '/repo/app.py',
                        line: 24,
                        evidence: 'Route handler does not enforce admin role.',
                        remediation: 'Add explicit role enforcement before serving admin data.',
                        sourceRoles: ['auth-flow-reviewer'],
                    },
                ],
            }), '');
            return { on: () => { } };
        }

        callback(new Error(`Unexpected command: ${cmd}`), '', '');
        return { on: () => { } };
    };

    (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
        execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });

    return { execMock, calls };
}

describe('CliAgentReviewScanner', () => {
    it('should run planner, specialist, and aggregator using an available backend', async () => {
        const { execMock, calls } = createExecMock();
        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            maxSpecialists: 4,
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        const deterministicIssues: SecurityIssue[] = [
            {
                ruleId: 'semgrep.auth',
                title: 'Auth issue',
                description: 'Potential auth issue',
                severity: 'high',
                filePath: '/repo/app.py',
                line: 10,
            },
        ];

        const result = await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues,
            changedFiles: ['app.py'],
        });

        expect(result.issues.length).toBe(1);
        expect(result.issues[0]?.title).toBe('Missing authorization check');
        expect(result.issues[0]?.source).toContain('auth-flow-reviewer');
        expect(result.issues[0]?.confidence).toBe('medium');
        expect(calls.filter(cmd => cmd.includes('codex exec')).length).toBe(4);
    });

    it('should return no findings when no backends are available', async () => {
        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }
            callback(new Error('not available'), '', '');
            return { on: () => { } };
        };
        (execMock as any)[promisify.custom] = () => Promise.reject(new Error('not available'));

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        const result = await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        expect(result.issues).toEqual([]);
        expect(result.scannerInfo).toContain('no backends available');
    });

    it('should reject a backend that fails readiness probing', async () => {
        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            if (cmd === 'codex --version') {
                callback(null, '1.0.0', '');
                return { on: () => { } };
            }

            if (cmd.includes('codex exec')) {
                callback(new Error('Opening authentication page in your browser'), '', 'Opening authentication page in your browser');
                return { on: () => { } };
            }

            callback(new Error(`Unexpected command: ${cmd}`), '', '');
            return { on: () => { } };
        };
        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        const available = await scanner.isAvailable();
        expect(available).toBe(false);
    });

    it('should run planner, specialist, and aggregator using the Gemini backend output envelope', async () => {
        const calls: string[] = [];
        let geminiCallCount = 0;

        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            calls.push(cmd);

            if (cmd === 'gemini --version') {
                callback(null, '1.2.3', '');
                return { on: () => { } };
            }

            if (cmd.includes('gemini --approval-mode plan --output-format json -p')) {
                geminiCallCount += 1;

                if (geminiCallCount === 1) {
                    callback(null, JSON.stringify({
                        session_id: 'session-ready',
                        response: '{"ready":true}',
                    }), '');
                    return { on: () => { } };
                }

                if (geminiCallCount === 2) {
                    callback(null, JSON.stringify({
                        session_id: 'session-plan',
                        response: JSON.stringify({
                            repoSummary: 'Express service with risky command execution',
                            specialists: [
                                {
                                    name: 'command-injection-reviewer',
                                    rationale: 'Shell execution is present',
                                    focus: 'Review command execution and path handling',
                                    paths: ['/repo/server.js'],
                                    checks: ['check shell command construction'],
                                    relevantFindingIds: ['semgrep.exec'],
                                },
                            ],
                        }),
                    }), '');
                    return { on: () => { } };
                }

                if (geminiCallCount === 3) {
                    callback(null, JSON.stringify({
                        session_id: 'session-specialist',
                        response: JSON.stringify({
                            findings: [
                                {
                                    title: 'Unsanitized shell command',
                                    description: 'User input reaches execSync without validation.',
                                    severity: 'high',
                                    confidence: 'high',
                                    filePath: '/repo/server.js',
                                    line: 8,
                                    evidence: 'execSync interpolates req.query.host directly.',
                                    remediation: 'Avoid shell execution or validate against an allowlist.',
                                },
                            ],
                        }),
                    }), '');
                    return { on: () => { } };
                }

                callback(null, JSON.stringify({
                    session_id: 'session-aggregate',
                    response: JSON.stringify({
                        findings: [
                            {
                                title: 'Unsanitized shell command',
                                description: 'User input reaches execSync without validation.',
                                severity: 'high',
                                confidence: 'high',
                                filePath: '/repo/server.js',
                                line: 8,
                                evidence: 'execSync interpolates req.query.host directly.',
                                remediation: 'Avoid shell execution or validate against an allowlist.',
                                sourceRoles: ['command-injection-reviewer'],
                            },
                        ],
                    }),
                }), '');
                return { on: () => { } };
            }

            callback(new Error(`Unexpected command: ${cmd}`), '', '');
            return { on: () => { } };
        };

        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: false },
                gemini: { enabled: true, binaryPath: 'gemini' },
                opencode: { enabled: false },
            },
        });

        const result = await scanner.scanWithContext(['/repo/server.js'], {
            repositoryRoot: '/repo',
            deterministicIssues: [
                {
                    ruleId: 'semgrep.exec',
                    title: 'Exec issue',
                    description: 'Potential shell execution risk',
                    severity: 'high',
                    filePath: '/repo/server.js',
                    line: 8,
                },
            ],
            changedFiles: ['server.js'],
        });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.ruleId).toBe('agent-review.unsanitized-shell-command');
        expect(result.issues[0]?.confidence).toBe('high');
        expect(calls.filter(cmd => cmd.includes('gemini --approval-mode plan --output-format json -p')).length).toBe(4);
    });

    it('should classify Gemini CLI argument mismatches with a specific hint', async () => {
        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            if (cmd === 'gemini --version') {
                callback(null, '1.2.3', '');
                return { on: () => { } };
            }

            callback(
                new Error('Invalid values:\n  Argument: approval-mode, Given: "plan", Choices: "default", "auto_edit", "yolo"\nUsage: gemini [options] [command]'),
                '',
                'Invalid values:\n  Argument: approval-mode, Given: "plan", Choices: "default", "auto_edit", "yolo"\nUsage: gemini [options] [command]'
            );
            return { on: () => { } };
        };

        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: false },
                gemini: { enabled: true, binaryPath: 'gemini' },
                opencode: { enabled: false },
            },
        });

        const available = await scanner.isAvailable();
        expect(available).toBe(false);
    });

    it('should scope planner input to changed files when configured', async () => {
        const { execMock, calls } = createExecMock();
        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            reviewScope: 'changed-files',
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        await scanner.scanWithContext(['/repo/app.py', '/repo/other.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: ['changed.ts'],
        });

        const plannerCall = calls.find(cmd => cmd.includes('codex exec') && cmd.includes('Requested scan paths')) || '';
        expect(plannerCall).toContain('/repo/changed.ts');
        expect(plannerCall).not.toContain('/repo/other.py');
    });

    it('should respect specialist concurrency when running specialists', async () => {
        const active = { count: 0, max: 0 };
        let codexExecCount = 0;

        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            if (cmd === 'codex --version') {
                callback(null, '1.0.0', '');
                return { on: () => { } };
            }

            if (cmd.includes('codex exec')) {
                codexExecCount += 1;

                if (codexExecCount === 1) {
                    callback(null, JSON.stringify({ ready: true }), '');
                    return { on: () => { } };
                }

                if (codexExecCount === 2) {
                    callback(null, JSON.stringify({
                        repoSummary: 'repo',
                        specialists: [
                            { name: 'one', rationale: 'r1', focus: 'f1', paths: ['/repo/a.ts'], checks: ['c1'] },
                            { name: 'two', rationale: 'r2', focus: 'f2', paths: ['/repo/b.ts'], checks: ['c2'] },
                            { name: 'three', rationale: 'r3', focus: 'f3', paths: ['/repo/c.ts'], checks: ['c3'] },
                        ],
                    }), '');
                    return { on: () => { } };
                }

                if (codexExecCount >= 3 && codexExecCount <= 5) {
                    active.count += 1;
                    active.max = Math.max(active.max, active.count);
                    setTimeout(() => {
                        active.count -= 1;
                        callback(null, JSON.stringify({
                            findings: [{
                                title: `Issue ${codexExecCount}`,
                                description: 'desc',
                                severity: 'medium',
                                confidence: 'medium',
                                filePath: '/repo/a.ts',
                                line: codexExecCount,
                                evidence: 'evidence',
                                remediation: 'fix',
                            }],
                        }), '');
                    }, 10);
                    return { on: () => { } };
                }

                callback(null, JSON.stringify({
                    findings: [{
                        title: 'Merged issue',
                        description: 'desc',
                        severity: 'medium',
                        confidence: 'medium',
                        filePath: '/repo/a.ts',
                        line: 1,
                        evidence: 'evidence',
                        remediation: 'fix',
                        sourceRoles: ['one', 'two', 'three'],
                    }],
                }), '');
                return { on: () => { } };
            }

            callback(new Error(`Unexpected command: ${cmd}`), '', '');
            return { on: () => { } };
        };

        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            specialistConcurrency: 2,
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        expect(active.max).toBe(2);
    });

    it('should pass a codex model override into the codex command', async () => {
        const { execMock, calls } = createExecMock();
        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: true, binaryPath: 'codex', model: 'gpt-5-codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        const plannerCall = calls.find(cmd => cmd.includes('codex exec') && cmd.includes('--model "gpt-5-codex"'));
        expect(plannerCall).toBeDefined();
    });

    it('should normalize codex output that prefixes json with plain text', async () => {
        let codexExecCount = 0;
        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            if (cmd === 'codex --version') {
                callback(null, '1.0.0', '');
                return { on: () => { } };
            }

            if (cmd.includes('codex exec')) {
                codexExecCount += 1;

                if (codexExecCount === 1) {
                    callback(null, 'Ready check complete\n{"ready":true}', '');
                    return { on: () => { } };
                }

                if (codexExecCount === 2) {
                    callback(null, JSON.stringify({
                        repoSummary: 'repo',
                        specialists: [],
                    }), '');
                    return { on: () => { } };
                }

                callback(null, JSON.stringify({ findings: [] }), '');
                return { on: () => { } };
            }

            callback(new Error(`Unexpected command: ${cmd}`), '', '');
            return { on: () => { } };
        };

        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        const available = await scanner.isAvailable();
        expect(available).toBe(true);
    });

    it('should prefer the configured backend when multiple are available', async () => {
        const calls: string[] = [];
        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            calls.push(cmd);

            if (cmd === 'codex --version' || cmd === 'opencode --version') {
                callback(null, '1.0.0', '');
                return { on: () => { } };
            }

            if (cmd.includes('codex exec')) {
                callback(null, JSON.stringify({ ready: true }), '');
                return { on: () => { } };
            }

            if (cmd.includes('opencode run')) {
                callback(null, JSON.stringify({ ready: true }), '');
                return { on: () => { } };
            }

            callback(new Error(`Unexpected command: ${cmd}`), '', '');
            return { on: () => { } };
        };

        (execMock as any)[promisify.custom] = (cmd: string, options?: any) => new Promise((resolve, reject) => {
            execMock(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });

        const scanner = new CliAgentReviewScanner({
            execFn: execMock as any,
            preferredBackend: 'codex',
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: true, binaryPath: 'opencode' },
            },
        });

        await scanner.isAvailable();
        const readinessCalls = calls.filter(cmd => cmd.includes('exec') || cmd.includes('run'));
        expect(readinessCalls[0]).toContain('codex exec');
    });
});
