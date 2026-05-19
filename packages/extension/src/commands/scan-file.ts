import * as vscode from 'vscode';
import type { FileSystem, SecurityService, CodeIssue } from '@backbrain/core';
import { createLogger } from '@backbrain/core';

const logger = createLogger('ScanFile');

import { SeverityPanelProvider } from '../views/severity-panel-provider';

interface CommandContext {
  fileSystem: FileSystem;
  securityService: SecurityService;
  severityPanelProvider: SeverityPanelProvider;
}

interface ScanFileOptions {
  quiet?: boolean;
}

const DEFAULT_ENABLED_SCANNERS = ['semgrep', 'gitleaks', 'trivy', 'osv-scanner', 'vibe-code', 'tree-sitter'];

function getSelectedScannerNames(): string[] {
  const config = vscode.workspace.getConfiguration('backbrain');
  const scannerNames = config.get<string[]>('enabledScanners', DEFAULT_ENABLED_SCANNERS);
  const agentReviewEnabled = config.get<boolean>('ai.agentReviewEnabled', false);
  const enabledAgentBackends = config.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']);
  return agentReviewEnabled && enabledAgentBackends.length > 0
    ? [...scannerNames, 'agent-review']
    : scannerNames;
}

const inFlightFileScans = new Map<string, Promise<void>>();

export async function scanFileCommand(ctx: CommandContext, uri?: vscode.Uri, options: ScanFileOptions = {}) {
  // Use provided URI (explorer context) or fallback to active editor
  const targetUri = uri || vscode.window.activeTextEditor?.document.uri;

  if (!targetUri) {
    vscode.window.showWarningMessage('No file selected to scan');
    return;
  }

  if (targetUri.scheme !== 'file') {
    logger.debug('Skipping scan for non-file URI', { scheme: targetUri.scheme, uri: targetUri.toString() });
    return;
  }

  const filePath = targetUri.fsPath;
  logger.info('Scanning file', { filePath });

  const existingScan = inFlightFileScans.get(filePath);
  if (existingScan) {
    logger.info('Scan already in progress for file, reusing existing run', { filePath });
    await existingScan;
    return;
  }

  try {
    const runScan = async () => {
      const content = await ctx.fileSystem.readFile(filePath);
      const result = await ctx.securityService.scanFile(filePath, content, {
        scanners: getSelectedScannerNames(),
        onStatus: (update) => ctx.severityPanelProvider.updateScanStatus(update),
      });

      // Merge the file scan result into the existing dashboard state
      ctx.severityPanelProvider.updateFileIssues(filePath, result.issues);

      const critical = result.issues.filter((i: CodeIssue) => i.severity === 'critical').length;
      const high = result.issues.filter((i: CodeIssue) => i.severity === 'high').length;
      const total = result.issues.length;

      if (!options.quiet && total > 0) {
        vscode.window.showInformationMessage(
          `BackBrain: Found ${total} issue(s) (${critical} critical, ${high} high). Details in Severity Panel.`
        );
      }

      logger.info('Scan complete', { total, critical, high });
    };

    const scanPromise = (async () => {
      if (options.quiet) {
        await runScan();
      } else {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "BackBrain: Scanning file...",
          cancellable: false
        }, async () => runScan());
      }
    })();

    inFlightFileScans.set(filePath, scanPromise);
    await scanPromise;
  } catch (error) {
    logger.error('Scan failed', { error });
    vscode.window.showErrorMessage(`BackBrain: Scan failed: ${error}`);
  } finally {
    inFlightFileScans.delete(filePath);
  }
}
