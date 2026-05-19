import * as vscode from 'vscode';
import {
  createLogger,
  ProviderRegistry,
  providerRegistry,
  SecurityService,
  type SecurityScanner,
  DEFAULT_SCANNERS,
  SemgrepScanner,
  GitleaksScanner,
  TrivyScanner,
  OSVScanner,
  VibeCodeScanner,
  CliAgentReviewScanner,
} from '@backbrain/core';
import { registerCommands } from './commands';
import { VSCodeFileSystem } from './adapters/vscode-filesystem';
import { initVSCodeLogging } from './logger-vscode';
import { SeverityPanelProvider } from './views/severity-panel-provider';
import { SemgrepInstaller } from './utils/semgrep-installer';
import { GitHubCliInstaller } from './utils/github-cli-installer';
import { VibeRuleLoader } from './utils/vibe-rule-loader';
import { initializeAIKeyService } from './services/ai-key-service';
import { initializeFixHistoryService } from './services/fix-history-service';
import { registerFixPreviewProvider } from './services/fix-preview-provider';

const logger = createLogger('Extension');

type OptionalToolId = 'gitleaks' | 'trivy' | 'osv-scanner';

async function configureInstalledOptionalScannerTools(
  cliInstaller: GitHubCliInstaller,
  onToolReady: (toolId: OptionalToolId, binaryPath: string) => void,
): Promise<void> {
  for (const toolId of ['gitleaks', 'trivy', 'osv-scanner'] as const) {
    const isAvailable = await cliInstaller.isAvailable(toolId);
    if (isAvailable) {
      const binaryPath = cliInstaller.getBinaryPath(toolId);
      onToolReady(toolId, binaryPath);
      logger.info(`${cliInstaller.getDisplayName(toolId)} found`, { path: binaryPath });
    }
  }
}

async function configureSemgrepScanner(installer: SemgrepInstaller, scanners: SecurityScanner[]): Promise<void> {
  const isSemgrepAvailable = await installer.isAvailable();
  if (!isSemgrepAvailable) {
    logger.info('Semgrep is not available; Semgrep scanning will stay disabled until it is installed');
    return;
  }

  const semgrepPath = installer.getSemgrepPath();
  scanners.forEach((scanner) => {
    if (scanner instanceof SemgrepScanner) {
      scanner.setBinaryPath(semgrepPath);
    }
  });
  logger.info('Semgrep found', { path: semgrepPath });
}

export async function activate(context: vscode.ExtensionContext) {
  // 1. Initialize VS Code specific logging immediately
  initVSCodeLogging(context);

  logger.info('BackBrain extension activating');

  try {
    // 2. Initialize independent components
    const fileSystem = new VSCodeFileSystem();
    const registry = new ProviderRegistry();
    providerRegistry.registerFilesystem('vscode', fileSystem, true);
    const installer = new SemgrepInstaller(context);
    const cliInstaller = new GitHubCliInstaller();

    // Initialize AI Key Service (internal, for future flexibility)
    initializeAIKeyService(context);

    // Initialize Fix History Service (Phase 10)
    initializeFixHistoryService(context);
    registerFixPreviewProvider(context);

    const config = vscode.workspace.getConfiguration('backbrain');
    const aiReviewEnabled = config.get<boolean>('ai.agentReviewEnabled', false);
    const enabledAgentBackends = config.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']);
    const preferredAgentBackend = config.get<'codex' | 'gemini' | 'opencode'>('ai.agentPreferredBackend', 'codex');
    const maxAgentSpecialists = config.get<number>('ai.maxAgentSpecialists', 6);
    const agentSpecialistConcurrency = config.get<number>('ai.agentSpecialistConcurrency', 3);
    const agentReviewScope = config.get<'workspace' | 'changed-files' | 'both'>('ai.agentReviewScope', 'both');
    const agentBinaryPaths = {
      codex: config.get<string>('ai.agentBinaryPathCodex', '').trim(),
      gemini: config.get<string>('ai.agentBinaryPathGemini', '').trim(),
      opencode: config.get<string>('ai.agentBinaryPathOpencode', '').trim(),
    };
    const agentModelOverrides = {
      codex: config.get<string>('ai.agentCodexModel', '').trim(),
      gemini: '',
      opencode: '',
    };
    logger.info('AI agent review configuration', {
      enabled: aiReviewEnabled,
      backends: enabledAgentBackends,
      preferredBackend: preferredAgentBackend,
      maxSpecialists: maxAgentSpecialists,
      specialistConcurrency: agentSpecialistConcurrency,
      reviewScope: agentReviewScope,
      binaryPathOverrides: Object.fromEntries(
        Object.entries(agentBinaryPaths).map(([key, value]) => [key, Boolean(value)])
      ),
      modelOverrides: Object.fromEntries(
        Object.entries(agentModelOverrides).map(([key, value]) => [key, Boolean(value)])
      ),
    });

    // Register scanners automatically from core
    let registeredScannerCount = 0;
    let vibeScanner: VibeCodeScanner | undefined;
    const scanners: SecurityScanner[] = DEFAULT_SCANNERS.map(entry => entry.scanner);

    if (aiReviewEnabled) {
      logger.info('Registering AI agent review scanner');
      scanners.push(new CliAgentReviewScanner({
        maxSpecialists: maxAgentSpecialists,
        specialistConcurrency: agentSpecialistConcurrency,
        reviewScope: agentReviewScope,
        preferredBackend: preferredAgentBackend,
        backends: {
          codex: {
            enabled: enabledAgentBackends.includes('codex'),
            ...(agentBinaryPaths.codex ? { binaryPath: agentBinaryPaths.codex } : {}),
            ...(agentModelOverrides.codex ? { model: agentModelOverrides.codex } : {}),
          },
          gemini: {
            enabled: enabledAgentBackends.includes('gemini'),
            ...(agentBinaryPaths.gemini ? { binaryPath: agentBinaryPaths.gemini } : {}),
          },
          opencode: {
            enabled: enabledAgentBackends.includes('opencode'),
            ...(agentBinaryPaths.opencode ? { binaryPath: agentBinaryPaths.opencode } : {}),
          },
        },
      }));
    }

    try {
      scanners.forEach((scanner) => {
        try {
          // Capture Vibe scanner for rule updates
          if (scanner instanceof VibeCodeScanner) {
            vibeScanner = scanner;
          }

          registry.register('scanner', scanner.name, scanner);
          registeredScannerCount++;
          logger.debug(`Registered scanner: ${scanner.name}`);
        } catch (err) {
          logger.error(`Failed to register scanner: ${scanner.name}`, { error: err });
        }
      });

      if (registeredScannerCount === 0) {
        vscode.window.showWarningMessage('BackBrain: No security scanners were registered. Scanning features will be unavailable.');
      }
    } catch (err) {
      logger.error('Unexpected error during scanner registration', { error: err });
    }

    const scannerToolConfigurationPromise = Promise.all([
      configureSemgrepScanner(installer, scanners),
      configureInstalledOptionalScannerTools(
        cliInstaller,
        (toolId, binaryPath) => {
          scanners.forEach((scanner) => {
            if (toolId === 'gitleaks' && scanner instanceof GitleaksScanner) {
              scanner.setBinaryPath(binaryPath);
            }
            if (toolId === 'trivy' && scanner instanceof TrivyScanner) {
              scanner.setBinaryPath(binaryPath);
            }
            if (toolId === 'osv-scanner' && scanner instanceof OSVScanner) {
              scanner.setBinaryPath(binaryPath);
            }
          });
        },
      ),
    ]).catch((error) => {
      logger.warn('Optional scanner tool configuration failed', { error });
    });

    // Load Vibe rules and setup watcher
    if (vibeScanner && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      const root = vscode.workspace.workspaceFolders[0]!.uri;
      const scanner = vibeScanner; // Capture for closure

      // Initialize config file if it doesn't exist
      await VibeRuleLoader.initializeConfig(root);

      // Initial load (awaited to prevent race condition)
      try {
        const rules = await VibeRuleLoader.loadRules(root);
        scanner.setRules(rules);
        logger.info(`Loaded ${rules.length} Vibe rules`);
      } catch (err) {
        logger.error('Failed to load initial Vibe rules', { error: err });
        vscode.window.showErrorMessage('BackBrain: Failed to load Vibe rules. Some scanning features may be limited.');
      }

      // Watch for changes
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '.backbrain/vibe-rules.json')
      );

      const reloadRules = async () => {
        logger.info('Reloading Vibe rules...');
        const rules = await VibeRuleLoader.loadRules(root);
        scanner.setRules(rules);
        logger.info(`Reloaded ${rules.length} Vibe rules`);
      };

      watcher.onDidChange(reloadRules);
      watcher.onDidCreate(reloadRules);
      watcher.onDidDelete(reloadRules);
      context.subscriptions.push(watcher);
    }

    // Create security service
    const securityService = new SecurityService(scanners);

    // Track UI initialization success
    let commandsInitialized = false;
    let panelInitialized = false;

    // Initialize Severity Panel Provider
    const severityPanelProvider = new SeverityPanelProvider(context.extensionUri, securityService);

    // Register UI components
    try {
      // 1. Register commands (now depends on severityPanelProvider)
      registerCommands(context, { fileSystem, securityService, severityPanelProvider });
      commandsInitialized = true;
    } catch (err) {
      logger.error('Failed to register commands', { error: err });
    }

    try {
      // 2. Register Webview Provider
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SeverityPanelProvider.viewType, severityPanelProvider)
      );
      panelInitialized = true;
    } catch (err) {
      logger.error('Failed to register Severity Panel', { error: err });
    }

    // Check if we have at least one functional UI path
    if (!commandsInitialized && !panelInitialized) {
      throw new Error('Failed to initialize both commands and the Severity Panel. The extension is non-functional.');
    } else if (!commandsInitialized) {
      const msg = 'BackBrain: Command registration failed. Some features will be unavailable.';
      logger.error(msg);
      vscode.window.showErrorMessage(msg);
    } else if (!panelInitialized) {
      const msg = 'BackBrain: Severity Panel failed to initialize. Security issues will not be visible in the sidebar.';
      logger.error(msg);
      vscode.window.showErrorMessage(msg);
    }

    // 3. Register Scanning Triggers
    const autoScanEnabled = config.get<boolean>('autoScan', true);
    const scanOnSaveEnabled = config.get<boolean>('scanOnSave', true);

    // Map to track debounce timers per file
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    // Helper to trigger file scan
    const triggerFileScan = async (document: vscode.TextDocument, delay: number = 0) => {
      if (document.uri.scheme !== 'file') return;
      if (!autoScanEnabled) return;

      const filePath = document.uri.fsPath;

      // Clear existing timer if any
      if (debounceTimers.has(filePath)) {
        clearTimeout(debounceTimers.get(filePath));
      }

      if (delay > 0) {
        const timer = setTimeout(() => {
          debounceTimers.delete(filePath);
          vscode.commands.executeCommand('backbrain.scanFile', document.uri, { quiet: true });
        }, delay);
        debounceTimers.set(filePath, timer);
      } else {
        vscode.commands.executeCommand('backbrain.scanFile', document.uri, { quiet: true });
      }
    };


    // Trigger workspace scan on startup if enabled
    const scanOnStartup = config.get<boolean>('scanOnStartup', true);

    if (autoScanEnabled && scanOnStartup) {
      logger.info('Auto-scan on startup is enabled, triggering workspace scan...');
      setTimeout(() => {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          vscode.commands.executeCommand('backbrain.scanWorkspace');
        }
      }, 3000); // Slightly longer delay to ensure everything is initialized
    } else {
      logger.info('Auto-scan on startup is disabled or restricted');
    }

    // Scan on file open
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        // Prioritize: Scan immediately on open
        triggerFileScan(doc, 0);
      })
    );

    // Scan on file save
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!scanOnSaveEnabled) return;
        // Debounce on save to handle rapid saves
        triggerFileScan(doc, 1000);
      })
    );

    // Scan valid active text editor immediately if exists
    if (vscode.window.activeTextEditor) {
      triggerFileScan(vscode.window.activeTextEditor.document);
    }

    logger.info('BackBrain extension activated successfully');

    void scannerToolConfigurationPromise;
  } catch (error) {
    logger.error('Critical failure during BackBrain activation', { error });

    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`BackBrain failed to initialize: ${message}. Check the Output panel for details.`);
  }
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate() {
  logger.info('BackBrain extension deactivating');
  // Add cleanup logic here as needed (e.g., disposing of file watchers)
}
