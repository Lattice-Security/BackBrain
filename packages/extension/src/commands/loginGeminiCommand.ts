/**
 * Login Gemini Command
 *
 * Registers a command that ensures the Gemini CLI is installed and
 * opens an interactive VS Code terminal for the user to authenticate.
 */

import * as vscode from 'vscode';
import { createLogger } from '@backbrain/core';
import { GeminiCliInstaller } from '../utils/gemini-cli-installer';

const logger = createLogger('LoginGeminiCommand');

let installerInstance: GeminiCliInstaller | null = null;

/**
 * Get or create the shared GeminiCliInstaller instance
 */
export function getGeminiCliInstaller(): GeminiCliInstaller {
    if (!installerInstance) {
        installerInstance = new GeminiCliInstaller();
    }
    return installerInstance;
}

/**
 * Register the backbrain.loginGemini command
 */
export function registerLoginGeminiCommand(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('backbrain.loginGemini', async () => {
        const installer = getGeminiCliInstaller();

        // Step 1: Ensure Gemini CLI is installed
        const isInstalled = await installer.isInstalled();
        if (!isInstalled) {
            const choice = await vscode.window.showInformationMessage(
                'Gemini CLI is not installed. Would you like to install it now?',
                'Install',
                'Cancel',
            );

            if (choice !== 'Install') {
                return;
            }

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Installing Gemini CLI...',
                        cancellable: false,
                    },
                    async (progress) => {
                        progress.report({ message: 'Running npm install -g @google/gemini-cli...' });
                        await installer.install();
                    },
                );
                vscode.window.showInformationMessage('Gemini CLI installed successfully!');
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error('Failed to install Gemini CLI', { error });
                vscode.window.showErrorMessage(`Failed to install Gemini CLI: ${msg}`);
                return;
            }
        }

        // Step 2: Check if already authenticated and show current account
        const currentAccount = installer.getAuthenticatedAccount();
        if (currentAccount) {
            const choice = await vscode.window.showInformationMessage(
                `Gemini CLI is signed in as ${currentAccount}. Re-authenticate with a different account?`,
                'Re-authenticate',
                'Cancel',
            );

            if (choice !== 'Re-authenticate') {
                return;
            }
        }

        // Step 3: Open login terminal
        vscode.window.showInformationMessage(
            'Opening Gemini CLI for authentication. Complete the sign-in flow in the terminal below.',
        );

        const terminal = await installer.loginViaTerminal();

        // Listen for terminal close to check auth status afterwards
        const disposable = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
            if (closedTerminal === terminal) {
                disposable.dispose();

                // Give a moment for auth state to settle
                await new Promise((resolve) => setTimeout(resolve, 2000));

                const nowAuthed = await installer.isAuthenticated();
                if (nowAuthed) {
                    const account = installer.getAuthenticatedAccount();
                    const accountInfo = account ? ` as ${account}` : '';
                    vscode.window.showInformationMessage(
                        `✅ Gemini CLI authenticated${accountInfo}! AI agent review is now available.`,
                    );
                    logger.info('Gemini CLI authentication completed successfully', { account });
                } else {
                    vscode.window.showWarningMessage(
                        'Gemini CLI authentication may not have completed. You can try again with "BackBrain: Login to Gemini CLI".',
                    );
                    logger.warn('Gemini CLI authentication status unclear after terminal close');
                }
            }
        });

        context.subscriptions.push(disposable);
    });
}
