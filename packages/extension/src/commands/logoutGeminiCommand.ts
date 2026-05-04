/**
 * Logout Gemini Command
 *
 * Registers a command that signs the user out of Gemini CLI
 * by clearing cached OAuth credentials.
 */

import * as vscode from 'vscode';
import { createLogger } from '@backbrain/core';
import { getGeminiCliInstaller } from './loginGeminiCommand';

const logger = createLogger('LogoutGeminiCommand');

/**
 * Register the backbrain.logoutGemini command
 */
export function registerLogoutGeminiCommand(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('backbrain.logoutGemini', async () => {
        const installer = getGeminiCliInstaller();

        // Check if there's an active account
        const account = installer.getAuthenticatedAccount();
        if (!account) {
            vscode.window.showInformationMessage('Gemini CLI: No account is currently signed in.');
            return;
        }

        // Confirm logout
        const choice = await vscode.window.showWarningMessage(
            `Sign out of Gemini CLI (${account})?`,
            { modal: true },
            'Sign Out',
        );

        if (choice !== 'Sign Out') {
            return;
        }

        try {
            await installer.logout();
            vscode.window.showInformationMessage(
                'Signed out of Gemini CLI. Use "BackBrain: Login to Gemini CLI" to sign in again.',
            );
            logger.info('User signed out of Gemini CLI', { account });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to sign out of Gemini CLI', { error });
            vscode.window.showErrorMessage(`Failed to sign out: ${msg}`);
        }
    });
}
