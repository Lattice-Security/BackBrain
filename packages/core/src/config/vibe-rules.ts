import type { Severity } from '../ports';

export interface VibeRule {
    id: string;
    title: string;
    description: string;
    severity: Severity;
    pattern?: RegExp | string | undefined;
    type: 'regex' | 'logic' | 'ai';
    aiPrompt?: string | undefined;
    examples?: { code: string; issue: string }[] | undefined;
    message?: ((match: any) => string) | undefined;
}

export const DEFAULT_VIBE_RULES: VibeRule[] = [
    {
        id: 'vibe-code.unhandled-promise',
        title: 'Unhandled Promise',
        description: 'Async operation without error handling',
        severity: 'high',
        pattern: /\b(fetch|axios\.[a-z]+)\(/g,
        type: 'logic',
    },
    {
        id: 'vibe-code.deprecated-api',
        title: 'Deprecated API',
        description: 'Use of deprecated React lifecycle methods',
        severity: 'medium',
        pattern: 'componentWillMount|componentWillReceiveProps|componentWillUpdate',
        type: 'regex',
    },
];
