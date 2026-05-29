/**
 * Set API Key Command
 * 
 * Securely stores an API key for a selected AI provider.
 */

import * as vscode from 'vscode';
import { createLogger } from '@backbrain/core';
import { getAIKeyService } from '../services/ai-key-service';
import { clearCachedAdapter } from '../services/ai-adapter-factory';

const logger = createLogger('SetApiKeyCommand');

const PROVIDERS: { label: string; id: string }[] = [
    { label: 'OpenAI', id: 'openai' },
    { label: 'Anthropic', id: 'anthropic' },
    { label: 'Google Gemini', id: 'google' },
    { label: 'xAI (Grok)', id: 'xai' },
    { label: 'DeepSeek', id: 'deepseek' },
    { label: 'NVIDIA NIM', id: 'nvidia' },
    { label: 'OpenRouter', id: 'openrouter' },
    { label: 'Groq', id: 'groq' },
];

/**
 * Register the setApiKey command
 */
export function registerSetApiKeyCommand(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('backbrain.setApiKey', async () => {
        // 1. Select provider
        const selection = await vscode.window.showQuickPick(PROVIDERS, {
            placeHolder: 'Select an AI provider to configure',
            title: 'BackBrain: Configure AI provider',
        });

        if (!selection) return;

        const providerId = selection.id;

        // 2. Prompt for API key
        const apiKey = await vscode.window.showInputBox({
            prompt: `Enter your API key for ${selection.label}`,
            placeHolder: 'sk-...',
            password: true, // Hide input
            title: `Configure ${selection.label}`,
            ignoreFocusOut: true,
        });

        if (!apiKey) {
            // Check if user want to clear the key
            if (apiKey === '') {
                const clearChoice = await vscode.window.showWarningMessage(
                    `Do you want to clear the stored API key for ${selection.label}?`,
                    'Clear Key',
                    'Cancel'
                );

                if (clearChoice === 'Clear Key') {
                    const keyService = getAIKeyService();
                    await keyService.clearApiKey(providerId);
                    clearCachedAdapter();
                    vscode.window.showInformationMessage(`API key for ${selection.label} cleared.`);
                    logger.info(`Cleared API key for ${providerId}`);
                }
            }
            return;
        }

        // 3. Store the key
        try {
            const keyService = getAIKeyService();
            await keyService.setApiKey(providerId, apiKey);

            // Clear cached adapter to force re-initialization with new key
            clearCachedAdapter();

            vscode.window.showInformationMessage(`API key for ${selection.label} stored securely.`);
            logger.info(`Stored API key for ${providerId}`);

            // Ask if they want to make this the default provider
            if (providerId === 'groq') {
                const groqConfig = vscode.workspace.getConfiguration('backbrain.ai');
                await groqConfig.update('agentGroqApiKey', apiKey, vscode.ConfigurationTarget.Global);
                await groqConfig.update('agentPreferredBackend', 'groq', vscode.ConfigurationTarget.Global);
                await groqConfig.update('provider', 'groq', vscode.ConfigurationTarget.Global);
                const backends = groqConfig.get<string[]>('agentBackends', ['codex', 'gemini', 'opencode']);
                if (!backends.includes('groq')) {
                    backends.push('groq');
                    await groqConfig.update('agentBackends', backends, vscode.ConfigurationTarget.Global);
                }
                vscode.window.showInformationMessage('Groq AI agent review configured! Use the Start scan button in the Scan tab.');
            } else {
                const config = vscode.workspace.getConfiguration('backbrain.ai');
                const currentProvider = config.get<string>('provider');

                if (currentProvider !== providerId) {
                    const makeDefault = await vscode.window.showInformationMessage(
                        `Set ${selection.label} as your active AI provider?`,
                        'Yes',
                        'No'
                    );

                    if (makeDefault === 'Yes') {
                        await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
                    }
                }
            }

        } catch (error) {
            logger.error(`Failed to store API key for ${providerId}`, { error });
            vscode.window.showErrorMessage(
                `Failed to store API key: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    });
}
