import * as vscode from 'vscode';
import * as nodePath from 'path';
import type { FileSystem, SecurityService, CodeIssue } from '@backbrain/core';
import { createLogger } from '@backbrain/core';

const logger = createLogger('ScanFile');

import { SeverityPanelProvider } from '../views/severity-panel-provider';
import { getWorkspacePackageNames, filterWorkspaceHallucinatedDeps } from '../services/workspace-packages-resolver';

interface CommandContext {
  fileSystem: FileSystem;
  securityService: SecurityService;
  severityPanelProvider: SeverityPanelProvider;
}

interface ScanFileOptions {
  quiet?: boolean;
}

const DEFAULT_ENABLED_SCANNERS = ['semgrep', 'gitleaks', 'trivy', 'osv-scanner', 'vibe-code', 'tree-sitter'];

/** Lockfile basenames that osv-scanner can analyze */
const OSV_LOCKFILE_NAMES = [
  'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml',
  'Gemfile.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock',
  'composer.lock', 'pubspec.lock', 'requirements.txt', 'gradle.lockfile',
  'packages.lock.json', 'pdm.lock', 'uv.lock',
];

function getSelectedScannerNames(filePath?: string): string[] {
  const config = vscode.workspace.getConfiguration('backbrain');
  let scannerNames = config.get<string[]>('enabledScanners', DEFAULT_ENABLED_SCANNERS);

  // OSV pre-flight: skip osv-scanner for non-lockfiles to avoid unnecessary subprocess spawn
  if (filePath) {
    const basename = nodePath.basename(filePath).toLowerCase();
    scannerNames = scannerNames.filter(s =>
      s !== 'osv-scanner' || OSV_LOCKFILE_NAMES.includes(basename)
    );
  }

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

  // Skip TypeScript declaration files — they only contain type information
  if (filePath.endsWith('.d.ts') || filePath.endsWith('.d.tsx')) {
    logger.debug('Skipping .d.ts file', { filePath });
    return;
  }

  // Skip files inside node_modules
  const sep = nodePath.sep;
  if (filePath.includes(`${sep}node_modules${sep}`) || filePath.startsWith(`node_modules${sep}`)) {
    logger.debug('Skipping file inside node_modules', { filePath });
    return;
  }

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
        scanners: getSelectedScannerNames(filePath),
        onStatus: (update) => ctx.severityPanelProvider.updateScanStatus(update),
      });

      // Filter out hallucinated-dep false positives for internal workspace packages
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const filteredIssues = workspaceRoot
        ? filterWorkspaceHallucinatedDeps(result.issues, await getWorkspacePackageNames(workspaceRoot))
        : result.issues;

      // Merge the file scan result into the existing dashboard state
      ctx.severityPanelProvider.updateFileIssues(filePath, filteredIssues);

      const critical = filteredIssues.filter((i: CodeIssue) => i.severity === 'critical').length;
      const high = filteredIssues.filter((i: CodeIssue) => i.severity === 'high').length;
      const total = filteredIssues.length;

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
