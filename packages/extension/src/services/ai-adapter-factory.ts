/**
 * AI Adapter Factory
 * 
 * Shared utility for creating and managing AI adapters with:
 * - Caching (reuse adapter instances)
 * - Fallback logic (try multiple providers)
 * - Rate limiting (prevent API spam)
 * - Explanation caching (avoid duplicate calls)
 */

import * as vscode from 'vscode';
import {
    VercelAIAdapter,
    createProviderConfig,
    AIAnalysisService,
    type AIProvider,
    type SupportedProvider,
    type SecurityIssue,
    type SecurityFix,
    createLogger,
} from '@backbrain/core';
import { CLIProviderAdapter, type CLIProviderConfig } from '@backbrain/core';
import { getAIKeyService } from './ai-key-service';

const logger = createLogger('AIAdapterFactory');

// ============================================================================
// Constants
// ============================================================================

const PROVIDERS_PRIORITY: SupportedProvider[] = ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'openrouter', 'nvidia'];
const RATE_LIMIT_MS = 3000; // Minimum 3 seconds between AI requests
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

// ============================================================================
// Cached Adapter Instance
// ============================================================================

let cachedAdapter: AIProvider | null = null;
let cachedProvider: SupportedProvider | 'cli-codex' | 'cli-gemini' | 'cli-opencode' | null = null;
let lastRequestTime = 0;

// ============================================================================
// Explanation Cache
// ============================================================================

interface CacheEntry<T> {
    value: T;
    timestamp: number;
}

const explanationCache = new Map<string, CacheEntry<string>>();
const fixCache = new Map<string, CacheEntry<SecurityFix>>();

/**
 * Generate a cache key for an issue
 */
function getCacheKey(issue: SecurityIssue): string {
    return `${issue.ruleId}:${issue.filePath}:${issue.line}:${issue.snippet?.slice(0, 50) || ''}`;
}

/**
 * Check if cache entry is still valid
 */
function isCacheValid<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
    if (!entry) return false;
    return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check if we're rate limited
 */
export function isRateLimited(): boolean {
    return Date.now() - lastRequestTime < RATE_LIMIT_MS;
}

/**
 * Get remaining cooldown time in milliseconds
 */
export function getRateLimitCooldown(): number {
    const elapsed = Date.now() - lastRequestTime;
    return Math.max(0, RATE_LIMIT_MS - elapsed);
}

/**
 * Wait for rate limit to clear
 */
async function waitForRateLimit(): Promise<void> {
    const cooldown = getRateLimitCooldown();
    if (cooldown > 0) {
        logger.debug(`Rate limited, waiting ${cooldown}ms`);
        await new Promise(resolve => setTimeout(resolve, cooldown));
    }
}

/**
 * Record that a request was made
 */
function recordRequest(): void {
    lastRequestTime = Date.now();
}

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Get or create an AI adapter with caching
 * 
 * @returns Cached adapter or newly created one, null if no provider available
 */
export async function getOrCreateAIAdapter(): Promise<AIProvider | null> {
    // Return cached adapter if still valid
    if (cachedAdapter && cachedProvider) {
        const isAvailable = await cachedAdapter.isAvailable();
        if (isAvailable) {
            return cachedAdapter;
        }
        // Cached adapter no longer available, clear it
        logger.info(`Cached adapter for ${cachedProvider} no longer available`);
        cachedAdapter = null;
        cachedProvider = null;
    }

    const keyService = getAIKeyService();
    const config = vscode.workspace.getConfiguration('backbrain.ai');

    // 1. Try configured provider first
    const preferredProvider = config.get<string>('provider') as SupportedProvider | undefined;
    const preferredModel = config.get<string>('model');

    if (preferredProvider) {
        const apiKey = await keyService.getApiKey(preferredProvider);
        if (apiKey) {
            const providerConfig = createProviderConfig(preferredProvider, apiKey, preferredModel || undefined);
            const adapter = new VercelAIAdapter(providerConfig);
            if (await adapter.isAvailable()) {
                cachedAdapter = adapter;
                cachedProvider = preferredProvider;
                logger.info(`Using preferred AI provider: ${preferredProvider} (from SecretStorage)`);
                return adapter;
            }
        }

        // Try environment fallback for preferred provider
        const providerConfig = createProviderConfig(preferredProvider, undefined, preferredModel || undefined);
        const adapter = new VercelAIAdapter(providerConfig);
        if (await adapter.isAvailable()) {
            cachedAdapter = adapter;
            cachedProvider = preferredProvider;
            logger.info(`Using preferred AI provider: ${preferredProvider} (from environment)`);
            return adapter;
        }
    }

    // 2. Fallback: Try providers in priority order
    for (const provider of PROVIDERS_PRIORITY) {
        if (provider === preferredProvider) continue; // Already tried

        const apiKey = await keyService.getApiKey(provider);
        if (apiKey) {
            const providerConfig = createProviderConfig(provider, apiKey);
            const adapter = new VercelAIAdapter(providerConfig);
            if (await adapter.isAvailable()) {
                cachedAdapter = adapter;
                cachedProvider = provider;
                logger.info(`Using fallback AI provider: ${provider} (from SecretStorage)`);
                return adapter;
            }
        }

        const providerConfig = createProviderConfig(provider);
        const adapter = new VercelAIAdapter(providerConfig);
        if (await adapter.isAvailable()) {
            cachedAdapter = adapter;
            cachedProvider = provider;
            logger.info(`Using fallback AI provider: ${provider} (from environment)`);
            return adapter;
        }
    }

    // 3. Fallback to CLI agents (codex, gemini, opencode) when no API key is available
    const agentBackends = config.get<string[]>('agentBackends', ['codex', 'gemini', 'opencode']);
    const preferredBackend = config.get<string>('agentPreferredBackend', 'codex');
    const binaryPaths: Record<string, string> = {
        codex: config.get('agentBinaryPathCodex', ''),
        gemini: config.get('agentBinaryPathGemini', ''),
        opencode: config.get('agentBinaryPathOpencode', ''),
    };
    const models: Record<string, string> = {
        codex: config.get('agentCodexModel', ''),
        opencode: config.get('agentOpencodeModel', ''),
    };
    const variants: Record<string, string> = {
        opencode: config.get('agentOpencodeVariant', ''),
    };

    // Sort backends so preferred is first
    const sortedBackends = [...agentBackends].sort((a, b) => {
        if (a === preferredBackend) return -1;
        if (b === preferredBackend) return 1;
        return 0;
    });

    for (const backend of sortedBackends) {
        if (!['codex', 'gemini', 'opencode'].includes(backend)) continue;

        const adapterConfig: CLIProviderConfig = {
            backend: backend as 'codex' | 'gemini' | 'opencode',
            binaryPath: binaryPaths[backend] || backend,
            ...(models[backend] ? { model: models[backend] } : {}),
            ...(variants[backend] ? { variant: variants[backend] } : {}),
        };

        const adapter = new CLIProviderAdapter(adapterConfig);
        if (await adapter.isAvailable()) {
            cachedAdapter = adapter;
            cachedProvider = `cli-${backend}` as any;
            logger.info(`Using CLI agent fallback: ${backend}`);
            return adapter;
        }
    }

    logger.warn('No AI provider or CLI agent available');
    return null;
}

/**
 * Get the currently active provider name
 */
export function getActiveProvider(): SupportedProvider | 'cli-codex' | 'cli-gemini' | 'cli-opencode' | null {
    return cachedProvider;
}

/**
 * Clear the cached adapter (useful for testing or when switching providers)
 */
export function clearCachedAdapter(): void {
    cachedAdapter = null;
    cachedProvider = null;
}

// ============================================================================
// AI Operations with Fallback
// ============================================================================

/**
 * Execute an AI operation with fallback to other providers on failure
 */
async function executeWithFallback<T>(
    operation: (adapter: AIProvider) => Promise<T>,
    operationName: string
): Promise<T> {
    // Wait for rate limit
    await waitForRateLimit();
    recordRequest();

    const keyService = getAIKeyService();
    const triedProviders: string[] = [];
    const maxRetries = 2;
    let lastProvider: string | null = null;
    let lastError: unknown = null;

    // Try with current cached adapter first
    if (cachedAdapter !== null && cachedProvider !== null) {
        const adapter = cachedAdapter;
        const provider = cachedProvider;
        lastProvider = provider;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await operation(adapter);
            } catch (error) {
                lastError = error;
                if (attempt === maxRetries - 1) {
                    logger.warn(`${operationName} failed with ${provider} after ${maxRetries} attempts`, { error });
                    triedProviders.push(provider);
                    cachedAdapter = null;
                    cachedProvider = null;
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
            }
        }
    }

    // Try other providers
    for (const provider of PROVIDERS_PRIORITY) {
        if (triedProviders.includes(provider)) continue;

        // Try to get adapter for this provider
        const apiKey = await keyService.getApiKey(provider);
        const providerConfig = apiKey
            ? createProviderConfig(provider, apiKey)
            : createProviderConfig(provider);

        const adapter = new VercelAIAdapter(providerConfig);
        if (!(await adapter.isAvailable())) continue;

        triedProviders.push(provider);
        lastProvider = provider;

        try {
            const result = await operation(adapter);
            // Success! Cache this adapter
            cachedAdapter = adapter;
            cachedProvider = provider;
            logger.info(`${operationName} succeeded with fallback provider: ${provider}`);
            return result;
        } catch (error) {
            lastError = error;
            logger.warn(`${operationName} failed with ${provider}`, { error });
        }
    }

    if (lastError instanceof Error && lastProvider) {
        try {
            (lastError as Error & { provider?: string }).provider = lastProvider;
        } catch {
            // Ignore if the error object is not extensible.
        }
        throw lastError;
    }

    throw new Error(`${operationName} failed with all available providers: ${triedProviders.join(', ')}`);
}

// ============================================================================
// Cached AI Operations
// ============================================================================

/**
 * Explain an issue with caching
 */
export async function explainIssueWithCache(
    issue: SecurityIssue,
    codeContext?: string
): Promise<string> {
    const cacheKey = getCacheKey(issue);

    // Check cache
    const cached = explanationCache.get(cacheKey);
    if (isCacheValid(cached)) {
        logger.debug('Returning cached explanation', { ruleId: issue.ruleId });
        return cached.value;
    }

    // Execute with fallback
    const explanation = await executeWithFallback(async (adapter) => {
        const service = new AIAnalysisService(adapter);
        return service.explainIssue(issue, codeContext);
    }, 'explainIssue');

    // Cache result
    explanationCache.set(cacheKey, {
        value: explanation,
        timestamp: Date.now(),
    });

    return explanation;
}

/**
 * Stream an issue explanation (no caching for streams)
 */
export async function* streamExplainIssue(
    issue: SecurityIssue,
    codeContext?: string
): AsyncIterable<string> {
    await waitForRateLimit();
    recordRequest();

    const adapter = await getOrCreateAIAdapter();
    if (!adapter) {
        throw new Error('No AI provider available');
    }

    const service = new AIAnalysisService(adapter);
    yield* service.explainIssueStream(issue, codeContext);
}

/**
 * Suggest a fix with caching
 */
export async function suggestFixWithCache(
    issue: SecurityIssue,
    codeContext?: string
): Promise<SecurityFix> {
    const cacheKey = getCacheKey(issue);

    // Check cache
    const cached = fixCache.get(cacheKey);
    if (isCacheValid(cached)) {
        logger.debug('Returning cached fix', { ruleId: issue.ruleId });
        return cached.value;
    }

    // Execute with fallback
    const fix = await executeWithFallback(async (adapter) => {
        const service = new AIAnalysisService(adapter);
        return service.suggestFix(issue, codeContext);
    }, 'suggestFix');

    // Cache result
    fixCache.set(cacheKey, {
        value: fix,
        timestamp: Date.now(),
    });

    return fix;
}

/**
 * Clear all caches
 */
export function clearCaches(): void {
    explanationCache.clear();
    fixCache.clear();
    logger.info('AI caches cleared');
}

/**
 * Show AI unavailable message to user
 */
export function showAIUnavailableMessage(): void {
    vscode.window.showInformationMessage(
        'AI features are not configured. Please set an API key or check your settings.',
        'Set API Key',
        'Open Settings'
    ).then(selection => {
        if (selection === 'Set API Key') {
            vscode.commands.executeCommand('backbrain.setApiKey');
        } else if (selection === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'backbrain.ai');
        }
    });
}
