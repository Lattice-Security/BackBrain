/**
 * AI Provider Configuration
 * 
 * Configuration types and defaults for AI providers.
 * BackBrain uses these internally - users don't configure providers directly.
 */

/**
 * Supported AI providers via Vercel AI SDK
 */
export type SupportedProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'openrouter' | 'nvidia' | 'groq';

/**
 * Configuration for an AI provider
 */
export interface AIProviderConfig {
    /** Provider identifier */
    provider: SupportedProvider;
    /** Model identifier (provider-specific) */
    model: string;
    /** API key for authentication */
    apiKey?: string;
    /** Optional base URL override (for proxies/custom endpoints) */
    baseUrl?: string;
}

/**
 * Default models for each provider
 * These are reasonable defaults that balance quality and cost
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
    google: 'gemini-2.0-flash',
    xai: 'grok-3',
    deepseek: 'deepseek-chat',
    openrouter: 'openai/gpt-4o-mini',
    nvidia: 'deepseek-ai/deepseek-v4-flash',
    groq: 'llama-3.3-70b-versatile',
};

/**
 * Environment variable names for API keys
 * BackBrain will read these server-side
 */
export const API_KEY_ENV_VARS: Record<SupportedProvider, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    groq: 'GROQ_API_KEY',
};

/**
 * Default base URLs for providers that require a non-standard endpoint.
 */
export const DEFAULT_BASE_URLS: Partial<Record<SupportedProvider, string>> = {
    openrouter: 'https://openrouter.ai/api/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    groq: 'https://api.groq.com/openai/v1',
};

/**
 * Default AI configuration
 * Uses OpenAI as the default provider with GPT-4o
 */
export const DEFAULT_AI_CONFIG: AIProviderConfig = {
    provider: 'openai',
    model: DEFAULT_MODELS.openai,
};

/**
 * Create a provider config with defaults filled in
 */
export function createProviderConfig(
    provider: SupportedProvider,
    apiKey?: string,
    model?: string,
    baseUrl?: string
): AIProviderConfig {
    const config: AIProviderConfig = {
        provider,
        model: model || DEFAULT_MODELS[provider],
    };
    if (apiKey !== undefined) {
        config.apiKey = apiKey;
    }
    const resolvedBaseUrl = baseUrl ?? DEFAULT_BASE_URLS[provider];
    if (resolvedBaseUrl !== undefined) {
        config.baseUrl = resolvedBaseUrl;
    }
    return config;
}

/**
 * Validate that a provider config has all required fields
 */
export function isValidConfig(config: AIProviderConfig): boolean {
    return !!(config.provider && config.model);
}

/**
 * Environment provider interface for cross-platform compatibility
 * This allows the extension context to inject its own env getter
 */
export interface EnvironmentProvider {
    getEnv(key: string): string | undefined;
}

/**
 * Default environment provider using process.env
 * Can be overridden for VS Code extension context
 */
let envProvider: EnvironmentProvider = {
    getEnv: (key: string) => {
        // Safe check for process.env existence
        if (typeof process !== 'undefined' && process.env) {
            return process.env[key];
        }
        return undefined;
    }
};

/**
 * Set a custom environment provider
 * Call this from extension activation to inject VS Code-compatible env access
 */
export function setEnvironmentProvider(provider: EnvironmentProvider): void {
    envProvider = provider;
}

/**
 * Get the current environment provider
 */
export function getEnvironmentProvider(): EnvironmentProvider {
    return envProvider;
}

/**
 * Check if API key is available for a provider (from env or config)
 */
export function hasApiKey(config: AIProviderConfig): boolean {
    if (config.apiKey) return true;
    const envVar = API_KEY_ENV_VARS[config.provider];
    return !!envProvider.getEnv(envVar);
}

/**
 * Get API key from config or environment
 */
export function getApiKey(config: AIProviderConfig): string | undefined {
    if (config.apiKey) return config.apiKey;
    const envVar = API_KEY_ENV_VARS[config.provider];
    return envProvider.getEnv(envVar);
}
