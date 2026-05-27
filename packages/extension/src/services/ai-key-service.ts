/**
 * AI Key Service
 * 
 * Internal service for managing AI provider API keys securely.
 * Uses VS Code's SecretStorage for secure key storage.
 * 
 * NOTE: This is internal infrastructure code. API keys are managed server-side
 * by BackBrain. Users do NOT provide their own API keys.
 * This service exists for future flexibility if we decide to allow user keys.
 */

import * as vscode from 'vscode';
import { createLogger } from '@backbrain/core';

const logger = createLogger('AIKeyService');

const KEY_PREFIX = 'backbrain.ai.apiKey.';

/**
 * AI Key Service for secure API key storage
 * 
 * INTERNAL USE ONLY - Not exposed to users
 */
export class AIKeyService {
    private secretStorage: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    /**
     * Store an API key for a provider
     */
    async setApiKey(provider: string, key: string): Promise<void> {
        const storageKey = `${KEY_PREFIX}${provider}`;
        try {
            await this.secretStorage.store(storageKey, key);
            logger.info(`API key stored for provider: ${provider}`);
        } catch (error) {
            logger.error(`Failed to store API key for ${provider}`, { error });
            throw error;
        }
    }

    /**
     * Retrieve an API key for a provider
     */
    async getApiKey(provider: string): Promise<string | undefined> {
        const storageKey = `${KEY_PREFIX}${provider}`;
        try {
            return await this.secretStorage.get(storageKey);
        } catch (error) {
            logger.error(`Failed to retrieve API key for ${provider}`, { error });
            return undefined;
        }
    }

    /**
     * Check if an API key exists for a provider
     */
    async hasApiKey(provider: string): Promise<boolean> {
        const key = await this.getApiKey(provider);
        return key !== undefined && key.length > 0;
    }

    /**
     * Clear an API key for a provider
     */
    async clearApiKey(provider: string): Promise<void> {
        const storageKey = `${KEY_PREFIX}${provider}`;
        try {
            await this.secretStorage.delete(storageKey);
            logger.info(`API key cleared for provider: ${provider}`);
        } catch (error) {
            logger.error(`Failed to clear API key for ${provider}`, { error });
            throw error;
        }
    }

    /**
     * Get all stored provider keys (names only, not the actual keys)
     */
    async getStoredProviders(): Promise<string[]> {
        // Note: VS Code SecretStorage doesn't provide a way to list all keys
        // We would need to track this separately or check known providers
        const knownProviders = ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'nvidia', 'openrouter'];
        const storedProviders: string[] = [];

        for (const provider of knownProviders) {
            if (await this.hasApiKey(provider)) {
                storedProviders.push(provider);
            }
        }

        return storedProviders;
    }
}

/**
 * Singleton instance holder
 */
let aiKeyServiceInstance: AIKeyService | null = null;

/**
 * Initialize the AI Key Service (call once during extension activation)
 */
export function initializeAIKeyService(context: vscode.ExtensionContext): AIKeyService {
    aiKeyServiceInstance = new AIKeyService(context);
    return aiKeyServiceInstance;
}

/**
 * Get the AI Key Service instance
 */
export function getAIKeyService(): AIKeyService {
    if (!aiKeyServiceInstance) {
        throw new Error('AIKeyService not initialized. Call initializeAIKeyService first.');
    }
    return aiKeyServiceInstance;
}
