import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AIProvider, AIContext, AIResponse } from '../ports';
import { createLogger } from '../utils/logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('CLIProviderAdapter');

export interface CLIProviderConfig {
    backend: 'codex' | 'gemini' | 'opencode';
    binaryPath: string;
    model?: string | undefined;
    variant?: string | undefined;
}

/**
 * AIProvider implementation that delegates to CLI agent backends
 * (codex, gemini, opencode) when no API key is configured.
 */
export class CLIProviderAdapter implements AIProvider {
    readonly name: string;
    private config: CLIProviderConfig;
    private available: boolean | null = null;

    constructor(config: CLIProviderConfig) {
        this.name = `cli-${config.backend}`;
        this.config = config;
    }

    async isAvailable(): Promise<boolean> {
        if (this.available !== null) return this.available;
        try {
            await execFileAsync(this.config.binaryPath, ['--version'], { timeout: 10_000 });
            this.available = true;
        } catch {
            this.available = false;
        }
        return this.available;
    }

    async complete(prompt: string, context: AIContext): Promise<AIResponse> {
        const fullPrompt = this.buildPrompt(prompt, context);
        const { binary, args } = this.buildArgs(fullPrompt);
        const cwd = context.filePath ? require('path').dirname(context.filePath) : process.cwd();

        logger.info(`Running ${this.config.backend} for explain/fix`, { promptLength: fullPrompt.length });

        const { stdout, stderr } = await execFileAsync(binary, args, {
            cwd,
            maxBuffer: 20 * 1024 * 1024,
            env: this.buildExecEnv(),
            timeout: 120_000,
        });

        const output = this.normalizeOutput(stdout);
        const content = output || stderr || '';

        return {
            content,
            model: this.config.backend,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
    }

    async *stream(prompt: string, context: AIContext): AsyncIterable<string> {
        // CLI agents don't support true streaming via this adapter.
        // Fall back to complete() and yield the full response.
        const response = await this.complete(prompt, context);
        yield response.content;
    }

    private buildPrompt(prompt: string, context: AIContext): string {
        const parts: string[] = [];
        if (context.systemPrompt) {
            parts.push(context.systemPrompt);
        }
        parts.push(prompt);
        if (context.content) {
            parts.push('\n\nCode context:\n```\n' + context.content + '\n```');
        }
        return parts.join('\n');
    }

    private buildArgs(prompt: string): { binary: string; args: string[] } {
        const { backend, binaryPath, model, variant } = this.config;

        switch (backend) {
            case 'opencode': {
                const args = ['run', '--print-logs', '--format', 'json'];
                if (model) args.push('--model', model);
                if (variant) args.push('--variant', variant);
                args.push(prompt);
                return { binary: binaryPath, args };
            }
            case 'codex': {
                const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'];
                if (model) args.push('--model', model);
                args.push(prompt);
                return { binary: binaryPath, args };
            }
            case 'gemini': {
                return { binary: binaryPath, args: ['--output-format', 'json', '-p', prompt] };
            }
            default:
                throw new Error(`Unsupported backend: ${backend}`);
        }
    }

    private buildExecEnv(): NodeJS.ProcessEnv {
        return { ...process.env };
    }

    private normalizeOutput(stdout: string): string {
        // Try to extract JSON response from CLI output
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.content) return parsed.content;
                if (parsed.text) return parsed.text;
                if (parsed.message) return parsed.message;
            }
        } catch {
            // Fall through to raw output
        }

        // For gemini/codex, the response might be wrapped in their format
        const lines = stdout.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('INFO') && !trimmed.startsWith('DEBUG');
        });

        return lines.join('\n').trim();
    }
}
