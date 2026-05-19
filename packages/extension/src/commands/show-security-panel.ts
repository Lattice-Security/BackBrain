import * as vscode from 'vscode';
import { createLogger } from '@backbrain/core';

const logger = createLogger('ShowSecurityPanel');

export async function showSecurityPanelCommand() {
  logger.info('Showing security panel');

  try {
    await vscode.commands.executeCommand('workbench.view.extension.backbrain-sidebar');
    await vscode.commands.executeCommand('backbrain.severityPanel.focus');
  } catch (error) {
    logger.error('Failed to show security panel', { error });
    vscode.window.showErrorMessage(`Failed to open Security Panel: ${error}`);
  }
}
