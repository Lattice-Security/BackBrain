/**
 * BackBrain Configuration
 * 
 * Environment-based configuration with debug mode support.
 */

import { getEnvVar } from './branding';

export interface BackBrainConfig {
    /** Enable debug mode */
    debug: boolean;

    /** Enable verbose logging */
    verboseLogging: boolean;

    /** AI backend to use */
    aiBackend: 'backbrain' | 'direct-openai' | 'direct-claude' | 'direct-gemini';

    /** Security scanning options */
    security: {
        /** Enable security scanning */
        enabled: boolean;
        /** Auto-fix security issues */
        autoFix: boolean;
        /** Minimum severity to report */
        minSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    };

    /** File patterns */
    files: {
        /** Patterns to include */
        include: string[];
        /** Patterns to exclude */
        exclude: string[];
    };
}

/** Default configuration */
export const defaultConfig: BackBrainConfig = {
    debug: getEnvVar('DEBUG') === 'true',
    verboseLogging: getEnvVar('VERBOSE') === 'true',
    aiBackend: 'backbrain',
    security: {
        enabled: true,
        autoFix: true,
        minSeverity: 'low',
    },
    files: {
        include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'],
        exclude: [
            '**/node_modules/**',
            '**/bower_components/**',
            '**/jspm_packages/**',
            '**/.pnpm/**',
            '**/.yarn/**',
            '**/vendor/**',
            '**/.venv/**',
            '**/venv/**',
            '**/env/**',
            '**/.tox/**',
            '**/__pypackages__/**',
            '**/site-packages/**',
            '**/.gradle/**',
            '**/.m2/**',
            '**/target/**',
            '**/Pods/**',
            '**/Carthage/**',
            '**/DerivedData/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/.git/**',
        ],
    },
};

/**
 * Get configuration from environment and user settings
 */
export function getConfig(userConfig: Partial<BackBrainConfig> = {}): BackBrainConfig {
    const config = deepMerge(defaultConfig, userConfig) as BackBrainConfig;
    validateConfig(config);
    return config;
}

/**
 * Merge additional ignore patterns (e.g. from .gitignore) into config
 */
export function mergeIgnorePatterns(config: BackBrainConfig, patterns: string[]): BackBrainConfig {
    return {
        ...config,
        files: {
            ...config.files,
            exclude: Array.from(new Set([...config.files.exclude, ...patterns])),
        },
    };
}

/**
 * Simple deep merge for configuration objects
 */
function deepMerge(target: any, source: any): any {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

function isObject(item: any): item is Record<string, any> {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

/**
 * Validate configuration values
 */
function validateConfig(config: BackBrainConfig): void {
    const validBackends = ['backbrain', 'direct-openai', 'direct-claude', 'direct-gemini'];
    if (!validBackends.includes(config.aiBackend)) {
        throw new Error(`Invalid aiBackend: ${config.aiBackend}. Must be one of: ${validBackends.join(', ')}`);
    }

    const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];
    if (!validSeverities.includes(config.security.minSeverity)) {
        throw new Error(`Invalid minSeverity: ${config.security.minSeverity}. Must be one of: ${validSeverities.join(', ')}`);
    }
}

export * from './branding';
export * from './vibe-rules';
export * from './rule-parser';
export * from './ai-config';
export * from './compliance-map';
