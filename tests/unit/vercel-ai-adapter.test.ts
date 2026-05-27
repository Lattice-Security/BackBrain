/**
 * Tests for Vercel AI Adapter
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { VercelAIAdapter, createAIAdapter } from '../../packages/core/src/adapters/vercel-ai-adapter';
import { createProviderConfig, type AIProviderConfig } from '../../packages/core/src/config/ai-config';

describe('VercelAIAdapter', () => {
    describe('constructor', () => {
        it('should create an adapter with the correct name', () => {
            const config: AIProviderConfig = {
                provider: 'openai',
                model: 'gpt-4o',
                apiKey: 'test-key',
            };
            const adapter = new VercelAIAdapter(config);
            expect(adapter.name).toBe('vercel-ai-openai');
        });

        it('should create adapter for each supported provider', () => {
            const providers: Array<'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'openrouter'> = [
                'openai', 'anthropic', 'google', 'xai', 'deepseek', 'openrouter'
            ];

            for (const provider of providers) {
                const config: AIProviderConfig = {
                    provider,
                    model: 'test-model',
                    apiKey: 'test-key',
                };
                const adapter = new VercelAIAdapter(config);
                expect(adapter.name).toBe(`vercel-ai-${provider}`);
            }
        });
    });

    describe('isAvailable', () => {
        it('should return false when no API key is provided', async () => {
            const config: AIProviderConfig = {
                provider: 'openai',
                model: 'gpt-4o',
            };
            const adapter = new VercelAIAdapter(config);
            const available = await adapter.isAvailable();
            expect(available).toBe(false);
        });

        it('should return true when API key is provided', async () => {
            const config: AIProviderConfig = {
                provider: 'openai',
                model: 'gpt-4o',
                apiKey: 'test-key',
            };
            const adapter = new VercelAIAdapter(config);
            const available = await adapter.isAvailable();
            expect(available).toBe(true);
        });
    });

    describe('getConfig', () => {
        it('should return config without API key', () => {
            const config: AIProviderConfig = {
                provider: 'anthropic',
                model: 'claude-3-sonnet',
                apiKey: 'secret-key',
            };
            const adapter = new VercelAIAdapter(config);
            const returnedConfig = adapter.getConfig();

            expect(returnedConfig.provider).toBe('anthropic');
            expect(returnedConfig.model).toBe('claude-3-sonnet');
            expect('apiKey' in returnedConfig).toBe(false);
        });
    });

    describe('updateConfig', () => {
        it('should update model without reinitializing provider', () => {
            const config: AIProviderConfig = {
                provider: 'openai',
                model: 'gpt-4o',
                apiKey: 'test-key',
            };
            const adapter = new VercelAIAdapter(config);

            adapter.updateConfig({ model: 'gpt-4o-mini' });

            const newConfig = adapter.getConfig();
            expect(newConfig.model).toBe('gpt-4o-mini');
            expect(newConfig.provider).toBe('openai');
        });
    });

    describe('NVIDIA NIM Auto-detection', () => {
        it('should automatically configure base URL and default model when OpenAI provider gets an nvapi- key', () => {
            const config: AIProviderConfig = {
                provider: 'openai',
                model: 'gpt-4o',
                apiKey: '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',
            };
            const adapter = new VercelAIAdapter(config);
            const resolvedConfig = adapter.getConfig();

            expect(resolvedConfig.provider).toBe('openai');
            expect(resolvedConfig.model).toBe('meta/llama-3.1-70b-instruct');
        });
    });
});

describe('createAIAdapter', () => {
    it('should create an adapter with default model when model is not specified', () => {
        const adapter = createAIAdapter('openai', 'test-key');
        const config = adapter.getConfig();
        expect(config.model).toBe('gpt-4o');
    });

    it('should create an adapter with custom model when specified', () => {
        const adapter = createAIAdapter('openai', 'test-key', 'gpt-4o-mini');
        const config = adapter.getConfig();
        expect(config.model).toBe('gpt-4o-mini');
    });

    it('should use default models for each provider', () => {
        const expectedModels: Record<string, string> = {
            openai: 'gpt-4o',
            anthropic: 'claude-sonnet-4-20250514',
            google: 'gemini-2.0-flash',
            xai: 'grok-3',
            deepseek: 'deepseek-chat',
            openrouter: 'openai/gpt-4o-mini',
        };

        for (const [provider, expectedModel] of Object.entries(expectedModels)) {
            const adapter = createAIAdapter(provider as any, 'test-key');
            const config = adapter.getConfig();
            expect(config.model).toBe(expectedModel);
        }
    });

    it('should assign the OpenRouter base URL automatically', () => {
        const config = createProviderConfig('openrouter', 'test-key');

        expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
        expect(config.model).toBe('openai/gpt-4o-mini');
    });
});
