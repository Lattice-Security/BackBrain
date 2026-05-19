export function injectMockMessages() {
  if (typeof acquireVsCodeApi !== 'undefined') return;

  const dispatch = (data: object) =>
    window.dispatchEvent(new MessageEvent('message', { data }));

  // Show scanning state after 500ms
  setTimeout(() => dispatch({ type: 'scanStarted' }), 500);

  setTimeout(() => dispatch({
    type: 'scanStatus',
    phase: 'agent-specialists',
    backend: 'gemini',
    level: 'info',
    message: 'Running specialist agents',
  }), 1000);

  // Show results after 3 seconds
  setTimeout(() => dispatch({
    type: 'scanComplete',
    issues: [
      {
        id: '1',
        title: 'Shell injection via prompt quoting',
        description: 'Unquoted input passed directly to execAsync shell command.',
        severity: 'critical',
        filePath: '/home/user/BackBrain/packages/core/src/adapters/cli-agent-review-scanner.ts',
        line: 312,
        column: 1,
        category: 'security',
        sourceType: 'agent-only',
        backend: 'gemini',
        snippet: 'const cmd = `gemini -p "${prompt}"`;\nawait execAsync(cmd, { env });',
      },
      {
        id: '2',
        title: 'Credentials exposed in error logs',
        description: 'Raw exec error objects containing auth tokens logged to output.',
        severity: 'high',
        filePath: '/home/user/BackBrain/packages/core/src/adapters/cli-agent-review-scanner.ts',
        line: 489,
        column: 1,
        category: 'security',
        sourceType: 'deterministic',
        source: 'semgrep',
        snippet: '} catch (err) {\n  this.logger.error("failed", err);\n}',
      },
      {
        id: '3',
        title: 'PATH hijacking via unvalidated binary resolution',
        description: 'Gemini binary resolved via PATH lookup without full path validation.',
        severity: 'high',
        filePath: '/home/user/BackBrain/packages/extension/src/utils/gemini-cli-installer.ts',
        line: 88,
        column: 1,
        category: 'security',
        sourceType: 'deterministic',
        source: 'semgrep',
        snippet: 'const binaryPath = await which("gemini");\nawait execFile(binaryPath, args);',
      },
      {
        id: '4',
        title: 'Missing execution timeout for AI scan operations',
        description: 'Non-probe AI scan calls have no timeout configured.',
        severity: 'medium',
        filePath: '/home/user/BackBrain/packages/core/src/adapters/cli-agent-review-scanner.ts',
        line: 201,
        column: 1,
        category: 'reliability',
        sourceType: 'agent-only',
        backend: 'gemini',
        snippet: 'await execAsync(command, {\n  env: geminiEnv,\n  maxBuffer: 20 * 1024 * 1024\n  // no timeout!\n});',
      },
      {
        id: '5',
        title: 'Symlink traversal during evidence verification',
        description: 'fs.readFile follows symlinks without validation.',
        severity: 'low',
        filePath: '/home/user/BackBrain/packages/core/src/adapters/cli-agent-review-scanner.ts',
        line: 634,
        column: 1,
        category: 'security',
        sourceType: 'agent-grounded',
        backend: 'gemini',
        confidence: 'medium',
        snippet: 'const content = await fs.readFile(filePath, "utf8");',
      },
    ],
  }), 3000);
}
