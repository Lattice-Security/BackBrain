/**
 * Vercel AI SDK Adapter
 * 
 * Unified adapter implementing our AIProvider port using Vercel AI SDK.
 * Supports OpenAI, Anthropic, Google, xAI, DeepSeek, and OpenRouter out of the box.
 */

import { generateText, streamText, type CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createDeepSeek } from '@ai-sdk/deepseek';

import type { AIProvider, AIContext, AIResponse } from '../ports';
import {
    type AIProviderConfig,
    type SupportedProvider,
    createProviderConfig,
    getApiKey,
    hasApiKey,
    DEFAULT_MODELS,
} from '../config/ai-config';
import { createLogger } from '../utils/logger';

const logger = createLogger('VercelAIAdapter');

/**
 * Provider factory type for creating model instances
 */
type ProviderFactory = ReturnType<typeof createOpenAI> |
    ReturnType<typeof createAnthropic> |
    ReturnType<typeof createGoogleGenerativeAI> |
    ReturnType<typeof createXai> |
    ReturnType<typeof createDeepSeek>;

/**
 * Vercel AI SDK Adapter
 * 
 * This adapter wraps the Vercel AI SDK to provide a unified interface
 * for all supported AI providers through our AIProvider port.
 */
export class VercelAIAdapter implements AIProvider {
    readonly name: string;
    private providerFactory: ProviderFactory | null = null;
    private config: AIProviderConfig;

    constructor(config: AIProviderConfig) {
        this.config = config;
        this.name = `vercel-ai-${config.provider}`;
        this.initializeProvider();
    }

    /**
     * Initialize the provider factory based on configuration
     */
    private initializeProvider(): void {
        const apiKey = getApiKey(this.config);
        if (!apiKey) {
            logger.warn(`No API key available for ${this.config.provider}`);
            return;
        }

        let resolvedBaseUrl = this.config.baseUrl;
        let resolvedModel = this.config.model;

        // Auto-detect NVIDIA NIM API key and configure it automatically
        if ((this.config.provider === 'openai' || this.config.provider === 'nvidia') && apiKey.startsWith('nvapi-')) {
            resolvedBaseUrl = 'https://integrate.api.nvidia.com/v1';
            if (this.config.model === 'gpt-4o' || !this.config.model || this.config.provider === 'nvidia') {
                resolvedModel = 'deepseek-ai/deepseek-v4-flash';
                this.config.model = resolvedModel;
            }
            logger.info('Auto-detected NVIDIA NIM API key.', {
                baseUrl: resolvedBaseUrl,
                model: resolvedModel
            });
        }

        // Build settings object, only including baseURL if defined
        const baseSettings: Record<string, unknown> = { apiKey };
        const settings = resolvedBaseUrl
            ? { ...baseSettings, baseURL: resolvedBaseUrl, compatibility: 'compatible' as const }
            : baseSettings;

        try {
            switch (this.config.provider) {
                case 'openai':
                case 'openrouter':
                case 'nvidia':
                    this.providerFactory = createOpenAI(settings);
                    break;
                case 'anthropic':
                    this.providerFactory = createAnthropic(settings);
                    break;
                case 'google':
                    this.providerFactory = createGoogleGenerativeAI(settings);
                    break;
                case 'xai':
                    this.providerFactory = createXai(settings);
                    break;
                case 'deepseek':
                    this.providerFactory = createDeepSeek(settings);
                    break;
                default:
                    logger.error(`Unsupported provider: ${this.config.provider}`);
            }
        } catch (error) {
            logger.error(`Failed to initialize provider ${this.config.provider}`, { error });
        }
    }

    /**
     * Get the model instance for the configured provider
     * 
     * Note: All Vercel AI SDK provider factories are callable functions
     * that return a LanguageModel when invoked with a model name.
     */
    private getModel() {
        if (!this.providerFactory) {
            throw new Error(`Provider ${this.config.provider} is not initialized. Check API key.`);
        }

        // Type assertion is safe because all provider factories are callable
        const factory = this.providerFactory as any;
        return factory(this.config.model);
    }

    /**
     * Make a completion request
     */
    async complete(prompt: string, context: AIContext): Promise<AIResponse> {
        logger.debug('Making completion request', {
            provider: this.config.provider,
            model: this.config.model,
            promptLength: prompt.length,
        });

        const model = this.getModel();

        // Build messages array for chat-style completion
        const messages: CoreMessage[] = [];

        if (context.systemPrompt) {
            messages.push({ role: 'system', content: context.systemPrompt });
        }

        // Add context content as a user message if provided
        if (context.content) {
            messages.push({
                role: 'user',
                content: `Context:\n\`\`\`${context.language || ''}\n${context.content}\n\`\`\``,
            });
        }

        // Add the main prompt
        messages.push({ role: 'user', content: prompt });

        try {
            const result = await generateText({
                model,
                messages,
            });

            logger.debug('Completion successful', {
                responseLength: result.text.length,
                usage: result.usage,
            });

            const response: AIResponse = {
                content: result.text,
                model: this.config.model,
            };

            if (result.usage) {
                response.usage = {
                    promptTokens: result.usage.inputTokens ?? 0,
                    completionTokens: result.usage.outputTokens ?? 0,
                    totalTokens: result.usage.totalTokens ?? 0,
                };
            }

            return response;
        } catch (error: any) {
            logger.error('Completion failed', {
                error: {
                    name: error.name,
                    message: error.message,
                    status: error.status,
                    data: error.data
                },
                provider: this.config.provider,
                model: this.config.model
            });
            throw error;
        }
    }

    /**
     * Stream a completion request
     */
    async *stream(prompt: string, context: AIContext): AsyncIterable<string> {
        logger.debug('Starting streaming request', {
            provider: this.config.provider,
            model: this.config.model,
        });

        const model = this.getModel();

        // Build messages array
        const messages: CoreMessage[] = [];

        if (context.systemPrompt) {
            messages.push({ role: 'system', content: context.systemPrompt });
        }

        if (context.content) {
            messages.push({
                role: 'user',
                content: `Context:\n\`\`\`${context.language || ''}\n${context.content}\n\`\`\``,
            });
        }

        messages.push({ role: 'user', content: prompt });

        try {
            const result = streamText({
                model,
                messages,
            });

            for await (const chunk of result.textStream) {
                yield chunk;
            }

            logger.debug('Streaming completed');
        } catch (error: any) {
            logger.error('Streaming failed', {
                error: {
                    name: error.name,
                    message: error.message,
                    status: error.status,
                    data: error.data
                },
                provider: this.config.provider,
                model: this.config.model
            });
            throw error;
        }
    }

    /**
     * Check if provider is available (has API key)
     */
    async isAvailable(): Promise<boolean> {
        return hasApiKey(this.config) && this.providerFactory !== null;
    }

    /**
     * Update the configuration (useful for changing models at runtime)
     */
    updateConfig(config: Partial<AIProviderConfig>): void {
        const providerChanged = config.provider && config.provider !== this.config.provider;

        this.config = { ...this.config, ...config };

        // Re-initialize if provider changed
        if (providerChanged) {
            this.initializeProvider();
        }
    }

    /**
     * Get current configuration (without API key for security)
     */
    getConfig(): Omit<AIProviderConfig, 'apiKey'> {
        const { apiKey, ...rest } = this.config;
        return rest;
    }
}

/**
 * Factory function to create an AI adapter for a specific provider
 */
export function createAIAdapter(
    provider: SupportedProvider,
    apiKey?: string,
    model?: string
): VercelAIAdapter {
    return new VercelAIAdapter(createProviderConfig(provider, apiKey, model));
}

/**
 * Create adapters for all providers with available API keys
 */
export function createAllAvailableAdapters(): Map<SupportedProvider, VercelAIAdapter> {
    const providers: SupportedProvider[] = ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'openrouter'];
    const adapters = new Map<SupportedProvider, VercelAIAdapter>();

    for (const provider of providers) {
        const adapter = createAIAdapter(provider);
        // Only add if the adapter is available (has API key)
        if (hasApiKey({ provider, model: DEFAULT_MODELS[provider] })) {
            adapters.set(provider, adapter);
        }
    }

    return adapters;
}
