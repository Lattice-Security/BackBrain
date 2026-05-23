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
  type AgentScanDepth,
  resolveScanDepthConfig,
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
import { GeminiCliInstaller } from './utils/gemini-cli-installer';

const logger = createLogger('Extension');

type OptionalToolId = 'gitleaks' | 'trivy' | 'osv-scanner';

async function configureInstalledOptionalScannerTools(
  cliInstaller: GitHubCliInstaller,
  onToolReady: (toolId: OptionalToolId, binaryPath: string) => void,
): Promise<void> {
  const toolIds = ['gitleaks', 'trivy', 'osv-scanner'] as const;
  const results = await Promise.all(toolIds.map(async (toolId) => {
    const isAvailable = await cliInstaller.isAvailable(toolId);
    return { toolId, isAvailable };
  }));
  for (const { toolId, isAvailable } of results) {
    if (!isAvailable) continue;
    const binaryPath = cliInstaller.getBinaryPath(toolId);
    onToolReady(toolId, binaryPath);
    logger.info(`${cliInstaller.getDisplayName(toolId)} found`, { path: binaryPath });
  }
}

async function ensureGeminiCliReady(
  geminiInstaller: GeminiCliInstaller,
): Promise<void> {
  // Step 1: Check if Gemini CLI is installed
  const isInstalled = await geminiInstaller.isInstalled();
  if (!isInstalled) {
    const choice = await vscode.window.showInformationMessage(
      'BackBrain: Gemini CLI is not installed. Install it for AI-powered agent security reviews (free tier: 60 req/min)?',
      'Install',
      'Skip',
    );

    if (choice !== 'Install') {
      logger.info('User skipped Gemini CLI installation');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Installing Gemini CLI...',
        cancellable: false,
      }, async (progress) => {
        progress.report({ message: 'Running npm install -g @google/gemini-cli...' });
        await geminiInstaller.install();
      });
      vscode.window.showInformationMessage('Gemini CLI installed successfully!');
    } catch (err) {
      logger.warn('Failed to install Gemini CLI', { error: err });
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      vscode.window.showWarningMessage(
        `BackBrain: Failed to install Gemini CLI. ${errorMsg}`,
        'Learn More',
      ).then(choice => {
        if (choice === 'Learn More') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/google-gemini/gemini-cli'));
        }
      });
      return;
    }
  } else {
    logger.info('Gemini CLI found', { path: geminiInstaller.getBinaryPath() });
  }

  // Step 2: Check authentication
  const isAuthed = await geminiInstaller.isAuthenticated();
  if (!isAuthed) {
    const choice = await vscode.window.showInformationMessage(
      'BackBrain: Gemini CLI is installed but not authenticated. Sign in to enable AI agent reviews.',
      'Login',
      'Later',
    );

    if (choice === 'Login') {
      vscode.commands.executeCommand('backbrain.loginGemini');
    }
  } else {
    logger.info('Gemini CLI is authenticated and ready');
  }
}

async function ensureSemgrepInstalled(
  installer: SemgrepInstaller,
  semgrepScanners: SemgrepScanner[],
  severityPanelProvider: SeverityPanelProvider,
): Promise<void> {
  const applySemgrepPath = (binaryPath: string) => {
    semgrepScanners.forEach(scanner => scanner.setBinaryPath(binaryPath));
    logger.info('Semgrep found', { path: binaryPath });
  };

  if (await installer.isAvailable()) {
    const semgrepPath = installer.getSemgrepPath();
    applySemgrepPath(semgrepPath);
    severityPanelProvider.clearStatus();
    return;
  }

  const hasIncompleteInstall = installer.hasIncompleteInstall();
  const installLabel = hasIncompleteInstall ? 'Repair Semgrep' : 'Install Semgrep';
  const missingMessage = hasIncompleteInstall
    ? 'Semgrep installation is incomplete. BackBrain is using limited scanners until it is repaired.'
    : 'Semgrep is not installed. BackBrain is using limited scanners until it is installed.';
  severityPanelProvider.setStatus('warn', missingMessage);

  const selection = await vscode.window.showWarningMessage(
    hasIncompleteInstall
      ? 'BackBrain: Semgrep installation is incomplete. Security scanning is limited until it is repaired.'
      : 'BackBrain: Semgrep is missing. Security scanning will be limited.',
    installLabel,
    'Learn More',
  );

  if (selection === 'Learn More') {
    vscode.env.openExternal(vscode.Uri.parse('https://semgrep.dev/docs/getting-started/'));
    return;
  }

  if (selection !== installLabel) {
    return;
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: hasIncompleteInstall ? 'Repairing Semgrep...' : 'Installing Semgrep...',
    cancellable: false,
  }, async (progress) => {
    try {
      await installer.install((message) => {
        progress.report({ message });
        severityPanelProvider.setStatus('info', `Semgrep setup in progress: ${message}`);
      });
      const semgrepPath = installer.getSemgrepPath();
      applySemgrepPath(semgrepPath);
      severityPanelProvider.setStatus('info', 'Semgrep installed successfully. Full security scanning is now available.');
      vscode.window.showInformationMessage('Semgrep installed successfully!');

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri.scheme === 'file') {
        void vscode.commands.executeCommand('backbrain.scanFile', activeEditor.document.uri, { quiet: true });
      }
    } catch (err) {
      logger.error('Failed to install Semgrep', { error: err });
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      severityPanelProvider.setStatus('error', `Semgrep installation failed: ${errorMsg}`);
      vscode.window.showErrorMessage(`BackBrain: ${errorMsg}`, 'Manual Install').then(choice => {
        if (choice === 'Manual Install') {
          vscode.env.openExternal(vscode.Uri.parse('https://semgrep.dev/docs/getting-started/'));
        }
      });
    }
  });
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
    const agentScanDepth = config.get<AgentScanDepth>('ai.agentScanDepth', 'developer');
    const tierConfig = resolveScanDepthConfig(agentScanDepth);

    const maxAgentSpecialistsInspect = config.inspect<number>('ai.maxAgentSpecialists');
    const userMaxAgentSpecialists = maxAgentSpecialistsInspect?.globalValue ?? maxAgentSpecialistsInspect?.workspaceValue;
    const maxAgentSpecialists = userMaxAgentSpecialists ?? tierConfig.maxSpecialists;

    const agentSpecialistConcurrencyInspect = config.inspect<number>('ai.agentSpecialistConcurrency');
    const userAgentSpecialistConcurrency = agentSpecialistConcurrencyInspect?.globalValue ?? agentSpecialistConcurrencyInspect?.workspaceValue;
    const agentSpecialistConcurrency = userAgentSpecialistConcurrency ?? tierConfig.concurrency;

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
      scanDepth: agentScanDepth,
      maxSpecialists: maxAgentSpecialists,
      specialistConcurrency: agentSpecialistConcurrency,
      delayBetweenCallsMs: tierConfig.delayBetweenCallsMs,
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
    const semgrepScanners: SemgrepScanner[] = [];
    let vibeScanner: VibeCodeScanner | undefined;
    const scanners: SecurityScanner[] = DEFAULT_SCANNERS.map(entry => entry.scanner);

    // Track which backends have already fired a notification this session so
    // we never spam the user with repeated toasts for the same failure.
    const authFailureNotified = new Set<string>();

    const agentReviewScanner = new CliAgentReviewScanner({
      maxSpecialists: maxAgentSpecialists,
      specialistConcurrency: agentSpecialistConcurrency,
      delayBetweenCallsMs: tierConfig.delayBetweenCallsMs,
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
      onAuthFailure: (backend) => {
        // After the user logs in and a new scan runs, the cache is cleared so
        // the probe fires again. Reset the notification guard at that point so
        // a subsequent genuine failure is still surfaced.
        if (authFailureNotified.has(backend)) {
          return;
        }
        authFailureNotified.add(backend);
        logger.warn('Agent backend authentication failure — surfacing user notification', { backend });

        vscode.window.showErrorMessage(
          `BackBrain: ${backend} is not authenticated. AI agent review is unavailable until you sign in.`,
          'Login to Gemini',
          'Reload Window',
        ).then(choice => {
          // After the user takes action, clear the guard so a future failure
          // (e.g. token expires again) is surfaced properly.
          authFailureNotified.delete(backend);
          if (choice === 'Login to Gemini') {
            void vscode.commands.executeCommand('backbrain.loginGemini');
          } else if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      },
    });
    scanners.push(agentReviewScanner);

    // Create the Gemini CLI installer instance
    const geminiInstaller = new GeminiCliInstaller();

    try {
      scanners.forEach((scanner) => {
        try {
          if (scanner instanceof SemgrepScanner) {
            semgrepScanners.push(scanner);
          }

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

    const scannerToolConfigurationPromise = configureInstalledOptionalScannerTools(
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
    ).catch((error) => {
      logger.warn('Optional scanner tool configuration failed', { error });
    });

    // Ensure Gemini CLI is installed and authenticated (non-blocking)
    const geminiSetupPromise = ensureGeminiCliReady(
      geminiInstaller,
    ).catch((error) => {
      logger.warn('Gemini CLI setup flow failed', { error });
    });

    // Load Vibe rules and setup watcher (non-blocking – UI registers first)
    if (vibeScanner && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      const root = vscode.workspace.workspaceFolders[0]!.uri;
      const scanner = vibeScanner; // Capture for closure

      // Fire-and-forget: initialise and load rules in the background
      void (async () => {
        try {
          await VibeRuleLoader.initializeConfig(root);
          const rules = await VibeRuleLoader.loadRules(root);
          scanner.setRules(rules);
          logger.info(`Loaded ${rules.length} Vibe rules`);
        } catch (err) {
          logger.error('Failed to load initial Vibe rules', { error: err });
          vscode.window.showErrorMessage('BackBrain: Failed to load Vibe rules. Some scanning features may be limited.');
        }
      })();

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
    severityPanelProvider.setScanDepthTier(tierConfig.label);
    const applyAgentReviewConfiguration = () => {
      const latestConfig = vscode.workspace.getConfiguration('backbrain');
      const latestDepth = latestConfig.get<AgentScanDepth>('ai.agentScanDepth', 'developer');
      const latestTier = resolveScanDepthConfig(latestDepth);
      const latestEnabledBackends = latestConfig.get<string[]>('ai.agentBackends', ['codex', 'gemini', 'opencode']);
      const latestPreferredBackend = latestConfig.get<'codex' | 'gemini' | 'opencode'>('ai.agentPreferredBackend', 'codex');
      const latestReviewScope = latestConfig.get<'workspace' | 'changed-files' | 'both'>('ai.agentReviewScope', 'both');
      const latestMaxSpecialistsInspect = latestConfig.inspect<number>('ai.maxAgentSpecialists');
      const latestSpecialistConcurrencyInspect = latestConfig.inspect<number>('ai.agentSpecialistConcurrency');
      const latestMaxSpecialists = (latestMaxSpecialistsInspect?.globalValue ?? latestMaxSpecialistsInspect?.workspaceValue) ?? latestTier.maxSpecialists;
      const latestSpecialistConcurrency = (latestSpecialistConcurrencyInspect?.globalValue ?? latestSpecialistConcurrencyInspect?.workspaceValue) ?? latestTier.concurrency;
      const latestBinaryPaths = {
        codex: latestConfig.get<string>('ai.agentBinaryPathCodex', '').trim(),
        gemini: latestConfig.get<string>('ai.agentBinaryPathGemini', '').trim(),
        opencode: latestConfig.get<string>('ai.agentBinaryPathOpencode', '').trim(),
      };
      const latestCodexModel = latestConfig.get<string>('ai.agentCodexModel', '').trim();

      agentReviewScanner.configure({
        maxSpecialists: latestMaxSpecialists,
        specialistConcurrency: latestSpecialistConcurrency,
        delayBetweenCallsMs: latestTier.delayBetweenCallsMs,
        reviewScope: latestReviewScope,
        preferredBackend: latestPreferredBackend,
        backends: {
          codex: {
            enabled: latestEnabledBackends.includes('codex'),
            binaryPath: latestBinaryPaths.codex || 'codex',
            ...(latestCodexModel ? { model: latestCodexModel } : {}),
          },
          gemini: {
            enabled: latestEnabledBackends.includes('gemini'),
            binaryPath: latestBinaryPaths.gemini || 'gemini',
          },
          opencode: {
            enabled: latestEnabledBackends.includes('opencode'),
            binaryPath: latestBinaryPaths.opencode || 'opencode',
          },
        },
      });
      severityPanelProvider.setScanDepthTier(latestTier.label);
      void severityPanelProvider.syncConfigurationState();
    };

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('backbrain.ai') || event.affectsConfiguration('backbrain.enabledScanners')) {
          applyAgentReviewConfiguration();
        }
      })
    );

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
    void geminiSetupPromise;
    void ensureSemgrepInstalled(installer, semgrepScanners, severityPanelProvider);
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
