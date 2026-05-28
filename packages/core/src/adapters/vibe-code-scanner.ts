import type { SecurityScanner, SecurityIssue, ScanResult } from '../ports';
import type { FileSystem } from '../ports';
import { DEFAULT_VIBE_RULES, type VibeRule } from '../config/vibe-rules';
import * as fs from 'fs';
import * as path from 'path';

// Node.js built-in modules that don't need to be in package.json
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  // With node: prefix
  'node:assert', 'node:buffer', 'node:child_process', 'node:cluster',
  'node:crypto', 'node:dns', 'node:events', 'node:fs', 'node:http',
  'node:http2', 'node:https', 'node:net', 'node:os', 'node:path',
  'node:process', 'node:readline', 'node:stream', 'node:timers',
  'node:tls', 'node:url', 'node:util', 'node:v8', 'node:vm',
  'node:worker_threads', 'node:zlib'
]);

export class VibeCodeScanner implements SecurityScanner {
  readonly name = 'vibe-code';
  private rules: VibeRule[] = DEFAULT_VIBE_RULES;
  private fileSystem: FileSystem | undefined;

  constructor(fileSystem?: FileSystem) {
    this.fileSystem = fileSystem;
  }

  setRules(rules: VibeRule[]) {
    this.rules = rules;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getSupportedExtensions(): string[] {
    return ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rb', '.php'];
  }

  async scanFile(filePath: string, content: string): Promise<SecurityIssue[]> {
    const issues: SecurityIssue[] = [];
    const lines = content.split('\n');

    // Run regex-based rules from vibe-rules.ts
    for (const rule of this.rules) {
      if (rule.type === 'regex') {
        issues.push(...this.runRegexRule(filePath, lines, rule));
      }
    }

    // Run built-in detectors
    issues.push(...this.detectUnhandledPromises(filePath, lines));
    issues.push(...this.detectTypeMismatches(filePath, lines));
    issues.push(...await this.detectHallucinatedDeps(filePath, content));

    return issues.filter(i => i.confidence === 'high');
  }

  async scan(paths: string[]): Promise<ScanResult> {
    const startTime = Date.now();
    const allIssues: SecurityIssue[] = [];
    const scannedFiles: string[] = [];

    // Filter to supported extensions
    const supportedExts = this.getSupportedExtensions();
    const filesToScan = paths.filter(p =>
      supportedExts.some(ext => p.endsWith(ext))
    );

    // Scan each file
    for (const filePath of filesToScan) {
      try {
        const content = await this.readFile(filePath);
        const issues = await this.scanFile(filePath, content);
        allIssues.push(...issues);
        scannedFiles.push(filePath);
      } catch (error) {
        // Skip files that can't be read (permissions, etc.)
        continue;
      }
    }

    return {
      issues: allIssues,
      scannedFiles,
      scanDurationMs: Date.now() - startTime,
      scannerInfo: 'VibeCode Scanner',
    };
  }

  /**
   * Read file content using injected FileSystem or fallback to Node.js fs
   */
  private async readFile(filePath: string): Promise<string> {
    if (this.fileSystem) {
      return this.fileSystem.readFile(filePath);
    }
    return fs.promises.readFile(filePath, 'utf-8');
  }

  private runRegexRule(filePath: string, lines: string[], rule: VibeRule): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    const pattern = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'g') : rule.pattern;
    if (!pattern) return issues;

    lines.forEach((line, idx) => {
      // Strip comments and strings to avoid false positives
      const cleanLine = this.stripCommentsAndStrings(line);
      if (cleanLine.match(pattern)) {
        issues.push({
          ruleId: rule.id,
          title: rule.title,
          description: rule.description,
          severity: rule.severity,
          confidence: 'high',
          filePath,
          line: idx + 1,
          snippet: line.trim(),
        });
      }
    });
    return issues;
  }

  /**
   * Basic heuristic to strip comments and strings from a line of code
   */
  private stripCommentsAndStrings(line: string): string {
    return line
      .replace(/\/\/.*$/, '') // Strip single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Strip multi-line comments (on same line)
      .replace(/(['"`])(?:(?=(\\?))\2.)*?\1/g, '""'); // Replace strings with empty ones
  }

  private detectUnhandledPromises(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check if this line includes a promise call
      const trimmed = line.trim();
      const promiseCall = /(\bawait\s+)?\s*\b(fetch|axios)\s*[.(]/.exec(trimmed);
      if (!promiseCall) continue;

      // If already awaited on the same line, it's handled
      if (promiseCall[1]) continue;

      // Collect dot-chained continuation lines (.then, .catch, etc.)
      let endIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (/^\s*\.\s*\w+\s*[.(]/.test(next)) {
          endIdx = j;
        } else {
          break;
        }
      }

      // Check the entire expression for handling (await at start, .then, .catch)
      const fullExpr = lines.slice(i, endIdx + 1).join('\n');
      if (/\bawait\b/.test(fullExpr) || /\.then\s*\(/.test(fullExpr) || /\.catch\s*\(/.test(fullExpr)) {
        i = endIdx;
        continue;
      }

      // Confidence: high if the call starts the line (standalone fire-and-forget)
      const startsLine = promiseCall.index === 0;

      issues.push({
        ruleId: 'vibe-code.unhandled-promise',
        title: 'Unhandled Promise',
        description: 'Async operation without error handling',
        severity: 'high',
        confidence: startsLine ? 'high' : 'medium',
        filePath,
        line: i + 1,
        snippet: trimmed,
      });

      i = endIdx;
    }

    return issues;
  }

  /**
   * Detect common type mismatches (basic heuristics without full AST)
   */
  private detectTypeMismatches(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    // Track variable types and whether they came from a literal assignment
    const varTypes = new Map<string, 'string' | 'number' | 'array' | 'object' | 'unknown'>();
    const literalVars = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Track type from initialization (stop at first semicolon to avoid grabbing sibling statements)
      const constMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*([^;]+)/);
      if (constMatch && constMatch[1] && constMatch[2]) {
        const varName = constMatch[1];
        const value = constMatch[2];
        if (/^['"`]/.test(value.trim())) {
          varTypes.set(varName, 'string');
          literalVars.add(varName);
        } else if (/^\d/.test(value.trim())) {
          varTypes.set(varName, 'number');
          literalVars.add(varName);
        } else if (/^\[/.test(value.trim())) {
          varTypes.set(varName, 'array');
          literalVars.add(varName);
        } else if (/^\{/.test(value.trim())) {
          varTypes.set(varName, 'object');
          literalVars.add(varName);
        }
      }

      // Helper: confidence is high only if the variable was assigned a literal
      const confidenceFor = (varName: string): 'high' | 'medium' =>
        literalVars.has(varName) ? 'high' : 'medium';

      // Detect parseInt/parseFloat on variables we know are numbers
      const parseMatch = line.match(/parseInt\((\w+)[\),]|parseFloat\((\w+)[\),]/);
      if (parseMatch) {
        const varName = parseMatch[1] ?? parseMatch[2];
        if (varName && varTypes.get(varName) === 'number') {
          issues.push({
            ruleId: 'vibe-code.type-mismatch',
            title: 'Type Mismatch',
            description: `parseInt/parseFloat called on '${varName}' which appears to be a number`,
            severity: 'low',
            confidence: confidenceFor(varName),
            filePath,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }

      // Detect .length on non-arrays/non-strings
      const lengthMatch = line.match(/(\w+)\.length/);
      if (lengthMatch && lengthMatch[1]) {
        const varName = lengthMatch[1];
        const type = varTypes.get(varName);
        if (type && type !== 'string' && type !== 'array') {
          issues.push({
            ruleId: 'vibe-code.type-mismatch',
            title: 'Type Mismatch',
            description: `'.length' accessed on '${varName}' which appears to be a ${type}`,
            severity: 'medium',
            confidence: confidenceFor(varName),
            filePath,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }

      // Detect string methods on numbers
      const stringMethodMatch = line.match(/(\w+)\.(split|substring|substr|charAt|slice|match|replace)\(/);
      if (stringMethodMatch && stringMethodMatch[1] && stringMethodMatch[2]) {
        const varName = stringMethodMatch[1];
        const methodName = stringMethodMatch[2];
        if (varTypes.get(varName) === 'number') {
          issues.push({
            ruleId: 'vibe-code.type-mismatch',
            title: 'Type Mismatch',
            description: `String method '${methodName}' called on '${varName}' which appears to be a number`,
            severity: 'high',
            confidence: confidenceFor(varName),
            filePath,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }

    return issues;
  }

  /**
   * Detect imports that don't exist in package.json (hallucinated dependencies)
   */
  private async detectHallucinatedDeps(filePath: string, content: string): Promise<SecurityIssue[]> {
    const issues: SecurityIssue[] = [];

    // Only check JS/TS files
    if (!/\.(js|ts|jsx|tsx)$/.test(filePath)) {
      return issues;
    }

    // Skip TypeScript declaration files — they contain type-only imports
    // for @types/* packages that are not runtime dependencies.
    if (/\.d\.(ts|tsx|mts|cts)$/.test(filePath)) {
      return issues;
    }

    // Strip multi-line comments (including JSDoc) and single-line comments
    // so code examples inside JSDoc blocks are not parsed as real imports.
    const cleanedContent = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // Extract all imports
    const importLines: { module: string; line: number; snippet: string }[] = [];
    const lines = cleanedContent.split('\n');

    // Match ES6 imports and require statements
    const importPatterns = [
      /import\s+.*\s+from\s+['"]([@\w\/-]+)['"]/,
      /import\s+['"]([@\w\/-]+)['"]/,
      /require\s*\(\s*['"]([@\w\/-]+)['"]\s*\)/
    ];

    lines.forEach((line, idx) => {
      for (const pattern of importPatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          const moduleName = match[1];
          // Skip relative imports and built-ins
          if (moduleName.startsWith('.') || moduleName.startsWith('/')) continue;
          if (NODE_BUILTINS.has(moduleName)) continue;
          // Also skip Node sub-path exports (e.g. path/posix, fs/promises, stream/web)
          const topLevel = moduleName.split('/')[0];
          if (NODE_BUILTINS.has(topLevel) || NODE_BUILTINS.has(`node:${topLevel}`)) continue;

          // Get the package name (handle scoped packages like @org/pkg)
          let pkgName: string;
          if (moduleName.startsWith('@')) {
            const parts = moduleName.split('/');
            pkgName = parts.slice(0, 2).join('/');
          } else {
            pkgName = moduleName.split('/')[0] ?? moduleName;
          }

          importLines.push({ module: pkgName, line: idx + 1, snippet: line.trim() });
        }
      }
    });

    if (importLines.length === 0) return issues;

    // Find ALL package.json files walking up to root
    const allPackageJsons = await this.findAllPackageJson(filePath);
    if (allPackageJsons.length === 0) return issues;

    // Merge deps from all levels into one set
    const allDeps = new Set<string>();
    for (const pkg of allPackageJsons) {
      for (const key of Object.keys(pkg.dependencies || {})) allDeps.add(key);
      for (const key of Object.keys(pkg.devDependencies || {})) allDeps.add(key);
      for (const key of Object.keys(pkg.peerDependencies || {})) allDeps.add(key);
      for (const key of Object.keys(pkg.optionalDependencies || {})) allDeps.add(key);
    }

    // Check each import against all discovered dependencies
    for (const { module: moduleName, line, snippet } of importLines) {
      if (!allDeps.has(moduleName)) {
        issues.push({
          ruleId: 'vibe-code.hallucinated-dep',
          title: 'Hallucinated Dependency',
          description: `Module '${moduleName}' is imported but not found in any package.json`,
          severity: 'high',
          confidence: 'high',
          filePath,
          line,
          snippet,
        });
      }
    }

    return issues;
  }

  /**
   * Find ALL package.json files walking up the directory tree to root
   */
  private async findAllPackageJson(filePath: string): Promise<Array<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>> {
    const results: Array<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }> = [];
    let dir = path.dirname(filePath);
    const root = path.parse(dir).root;

    while (dir !== root) {
      const pkgPath = path.join(dir, 'package.json');
      try {
        const content = await this.readFile(pkgPath);
        results.push(JSON.parse(content));
      } catch {
        // no package.json at this level
      }
      dir = path.dirname(dir);
    }

    return results;
  }
}
