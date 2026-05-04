import * as vscode from 'vscode';
import type { FileSystem, SecurityService } from '@backbrain/core';
import { scanFileCommand } from './scan-file';
import { scanWorkspaceCommand } from './scan-workspace';
import { showSecurityPanelCommand } from './show-security-panel';
import { registerExplainIssueCommand } from './explainIssueCommand';
import { registerSuggestFixCommand } from './suggestFixCommand';
import { registerApplyFixCommand } from './applyFixCommand';
import { registerRevertFixCommand } from './revertFixCommand';
import { registerBatchFixCommand } from './batchFixCommand';
import { registerGenerateReportCommand } from './generateReportCommand';
import { registerSetApiKeyCommand } from './setApiKeyCommand';
import { registerLoginGeminiCommand } from './loginGeminiCommand';
import { registerLogoutGeminiCommand } from './logoutGeminiCommand';

import { SeverityPanelProvider } from '../views/severity-panel-provider';

interface CommandContext {
  fileSystem: FileSystem;
  securityService: SecurityService;
  severityPanelProvider: SeverityPanelProvider;
}

export function registerCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('backbrain.scanFile', (uri?: vscode.Uri, options?: { quiet?: boolean }) => scanFileCommand(ctx, uri, options)),
    vscode.commands.registerCommand('backbrain.scanWorkspace', () => scanWorkspaceCommand(ctx)),
    vscode.commands.registerCommand('backbrain.showSecurityPanel', () => showSecurityPanelCommand()),
    // AI-powered commands
    registerExplainIssueCommand(context),
    registerSuggestFixCommand(context),
    // Fix commands (Phase 10)
    registerApplyFixCommand(context),
    registerRevertFixCommand(context),
    registerBatchFixCommand(context),
    // Report command (Phase 11)
    registerGenerateReportCommand(context, ctx.severityPanelProvider),
    // Configuration commands
    registerSetApiKeyCommand(context),
    registerLoginGeminiCommand(context),
    registerLogoutGeminiCommand(context)
  );
}
