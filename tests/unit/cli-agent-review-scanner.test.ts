import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';

import { CliAgentReviewScanner } from '../../packages/core/src/adapters/cli-agent-review-scanner';
import type { SecurityIssue } from '../../packages/core/src/ports';

function createExecMock(filePath = '/repo/app.py') {
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
                            paths: [filePath],
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
                            filePath,
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
                        filePath,
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

function createTempRepo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'bb-agent-review-'));
    for (const [relativePath, content] of Object.entries(files)) {
        const absolutePath = join(root, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, content, 'utf8');
    }
    return root;
}

describe('CliAgentReviewScanner', () => {
    it('should run planner, specialist, and aggregator using an available backend', async () => {
        const repoRoot = createTempRepo({
            'app.py': [
                'def route():',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    pass',
                '    # Route handler does not enforce admin role.',
                '    return admin_data()',
            ].join('\n'),
        });
        const appPath = join(repoRoot, 'app.py');
        const { execMock, calls } = createExecMock(appPath);
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
                filePath: appPath,
                line: 10,
            },
        ];

        const result = await scanner.scanWithContext([appPath], {
            repositoryRoot: repoRoot,
            deterministicIssues,
            changedFiles: ['app.py'],
        });

        expect(result.issues.length).toBe(1);
        expect(result.issues[0]?.title).toBe('Missing authorization check');
        expect(result.issues[0]?.source).toContain('auth-flow-reviewer');
        expect(result.issues[0]?.confidence).toBe('medium');
        expect(result.issues[0]?.verificationStatus).toBe('verified');
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

        const result = await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        expect(result.issues).toEqual([]);
        expect(result.scannerInfo).toContain('no backends available');
    });

    it('should run planner, specialist, and aggregator using the Gemini backend output envelope', async () => {
        const calls: string[] = [];
        const repoRoot = createTempRepo({
            'server.js': [
                'const express = require("express");',
                'const app = express();',
                'app.get("/", (req, res) => {',
                '  res.send("ok");',
                '});',
                '',
                'function ping(req) {',
                '  // execSync interpolates req.query.host directly.',
                '  return execSync(`ping ${req.query.host}`);',
                '}',
            ].join('\n'),
        });
        const serverPath = join(repoRoot, 'server.js');
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
                                    filePath: serverPath,
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
                                filePath: serverPath,
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

        const result = await scanner.scanWithContext([serverPath], {
            repositoryRoot: repoRoot,
            deterministicIssues: [
                {
                    ruleId: 'semgrep.exec',
                    title: 'Exec issue',
                    description: 'Potential shell execution risk',
                    severity: 'high',
                    filePath: serverPath,
                    line: 8,
                },
            ],
            changedFiles: ['server.js'],
        });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.ruleId).toBe('agent-review.unsanitized-shell-command');
        expect(result.issues[0]?.confidence).toBe('high');
        expect(result.issues[0]?.sourceType).toBe('agent-only');
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

        const result = await scanner.scanWithContext(['/repo/server.js'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        expect(result.issues).toEqual([]);
        expect(result.scannerInfo).toContain('no backends available');
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

    it('should parse opencode JSON event streams and omit noisy print logs', async () => {
        const calls: string[] = [];
        const repoRoot = createTempRepo({
            'server.ts': [
                'export function handler(input: string) {',
                '  // user input reaches shell command',
                '  return input;',
                '}',
            ].join('\n'),
        });
        const serverPath = join(repoRoot, 'server.ts');
        let opencodeRunCount = 0;

        const asOpencodeEvents = (text: string) => [
            JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
            JSON.stringify({ type: 'text', part: { type: 'text', text } }),
            JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { total: 42 } } }),
        ].join('\n');

        const execMock = (cmd: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options;
            }

            calls.push(cmd);

            if (cmd === 'opencode --version') {
                callback(null, '1.15.10', '');
                return { on: () => { } };
            }

            if (cmd.includes('opencode run')) {
                opencodeRunCount += 1;

                if (opencodeRunCount === 1) {
                    callback(null, asOpencodeEvents(JSON.stringify({ ready: true })), '');
                    return { on: () => { } };
                }

                if (opencodeRunCount === 2) {
                    callback(null, asOpencodeEvents(JSON.stringify({
                        repoSummary: 'TypeScript service',
                        specialists: [{
                            name: 'shell-reviewer',
                            rationale: 'Shell-sensitive input is present',
                            focus: 'Review shell command construction',
                            paths: [serverPath],
                            checks: ['check shell input handling'],
                        }],
                    })), '');
                    return { on: () => { } };
                }

                if (opencodeRunCount === 3) {
                    callback(null, asOpencodeEvents(JSON.stringify({
                        findings: [{
                            title: 'Untrusted shell input',
                            description: 'User input reaches shell command handling without validation.',
                            severity: 'high',
                            confidence: 'medium',
                            filePath: serverPath,
                            line: 2,
                            evidence: 'user input reaches shell command',
                            remediation: 'Validate or avoid shell command construction.',
                        }],
                    })), '');
                    return { on: () => { } };
                }

                callback(null, asOpencodeEvents(JSON.stringify({
                    findings: [{
                        title: 'Untrusted shell input',
                        description: 'User input reaches shell command handling without validation.',
                        severity: 'high',
                        confidence: 'medium',
                        filePath: serverPath,
                        line: 2,
                        evidence: 'user input reaches shell command',
                        remediation: 'Validate or avoid shell command construction.',
                        sourceRoles: ['shell-reviewer'],
                    }],
                })), '');
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
                gemini: { enabled: false },
                opencode: { enabled: true, binaryPath: 'opencode' },
            },
        });

        const result = await scanner.scanWithContext([serverPath], {
            repositoryRoot: repoRoot,
            deterministicIssues: [],
            changedFiles: ['server.ts'],
        });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.backend).toBe('opencode');
        expect(calls.some(cmd => cmd.includes('opencode run --format json'))).toBe(true);
        expect(calls.some(cmd => cmd.includes('--print-logs'))).toBe(false);
    });

    it('should downgrade unverifiable AI findings instead of dropping the whole scan', async () => {
        const repoRoot = createTempRepo({
            'app.py': [
                'def route():',
                '    return "ok"',
            ].join('\n'),
        });
        const appPath = join(repoRoot, 'app.py');
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
                            {
                                name: 'reviewer',
                                rationale: 'rationale',
                                focus: 'focus',
                                paths: [appPath],
                                checks: ['check auth'],
                            },
                        ],
                    }), '');
                    return { on: () => { } };
                }

                if (codexExecCount === 3) {
                    callback(null, JSON.stringify({
                        findings: [{
                            title: 'Suspicious route',
                            description: 'desc',
                            severity: 'medium',
                            confidence: 'medium',
                            filePath: appPath,
                            line: 2,
                            evidence: 'missing evidence text',
                            remediation: 'fix it',
                        }],
                    }), '');
                    return { on: () => { } };
                }

                callback(null, JSON.stringify({
                    findings: [{
                        title: 'Suspicious route',
                        description: 'desc',
                        severity: 'medium',
                        confidence: 'medium',
                        filePath: appPath,
                        line: 2,
                        evidence: 'missing evidence text',
                        remediation: 'fix it',
                        sourceRoles: ['reviewer'],
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
            backends: {
                codex: { enabled: true, binaryPath: 'codex' },
                gemini: { enabled: false },
                opencode: { enabled: false },
            },
        });

        const result = await scanner.scanWithContext([appPath], {
            repositoryRoot: repoRoot,
            deterministicIssues: [],
            changedFiles: ['app.py'],
        });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.verificationStatus).toBe('unverified');
        expect(result.issues[0]?.degraded).toBe(true);
    });

    it('should prefer the configured backend when multiple are available', async () => {
        const calls: string[] = [];
        let codexExecCount = 0;
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
                codexExecCount += 1;
                callback(null, JSON.stringify(
                    codexExecCount === 1
                        ? { ready: true }
                        : { repoSummary: 'repo', specialists: [] }
                ), '');
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

        await scanner.scanWithContext(['/repo/app.py'], {
            repositoryRoot: '/repo',
            deterministicIssues: [],
            changedFiles: [],
        });

        const plannerCall = calls.find(cmd => cmd.includes('codex exec') && cmd.includes('Requested scan paths'));
        expect(plannerCall).toBeDefined();
    });
});
