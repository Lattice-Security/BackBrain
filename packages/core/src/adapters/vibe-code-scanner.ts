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

    // Run rules based on type
    for (const rule of this.rules) {
      if (rule.type === 'regex') {
        issues.push(...this.runRegexRule(filePath, lines, rule));
      } else if (rule.type === 'logic') {
        // Custom logic for specific rules
        switch (rule.id) {
          case 'vibe-code.missing-import':
            issues.push(...this.detectMissingImports(filePath, lines));
            break;
          case 'vibe-code.name-mismatch':
            issues.push(...this.detectInconsistentNaming(filePath, lines));
            break;
          case 'vibe-code.unhandled-promise':
            issues.push(...this.detectUnhandledPromises(filePath, lines));
            break;
        }
      } else if (rule.type === 'ai') {
        // AI rules are handled by the AI agent in Phase 9
        // For now, we just skip them in the local scanner
      }
    }

    // Run additional detectors (Phase 8.2)
    issues.push(...this.detectDeadCode(filePath, lines));
    issues.push(...this.detectTypeMismatches(filePath, lines));
    issues.push(...await this.detectHallucinatedDeps(filePath, content));

    return issues;
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

  private detectMissingImports(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    const importedModules = new Set<string>();
    const declaredNames = new Set<string>();

    lines.forEach((line) => {
      // ES6 imports (import X from '...', import { ... } from '...', import '...')
      const es6Match = line.match(/import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+\s+(?:,\s*\{[^}]*\})?)?\s*from\s+['"]([^'"]+)['"]/);
      if (es6Match?.[1]) {
        importedModules.add(es6Match[1]);
      }
      // Side-effect imports: import '...'
      const sideEffectMatch = line.match(/^import\s+['"]([^'"]+)['"]/);
      if (sideEffectMatch?.[1]) {
        importedModules.add(sideEffectMatch[1]);
      }
      // CommonJS require
      const requireMatch = line.match(/(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (requireMatch?.[1]) {
        importedModules.add(requireMatch[1]);
      }
    });

    // Track local declarations to avoid flagging them as modules
    lines.forEach((line) => {
      const decl = line.match(/(?:const|let|var|function)\s+(\w+)/);
      if (decl?.[1]) declaredNames.add(decl[1]);
    });

    const commonModules = [
      'fs', 'path', 'http', 'https', 'crypto', 'util', 'os', 'stream',
      'child_process', 'events', 'url', 'querystring', 'zlib',
      'axios', 'lodash', 'express', 'moment', 'chalk',
    ];

    lines.forEach((line, idx) => {
      const code = this.stripCommentsAndStrings(line);
      for (const mod of commonModules) {
        const re = new RegExp(`\\b${mod}\\.`, 'i');
        if (re.test(code) && !importedModules.has(mod) && !declaredNames.has(mod)) {
          issues.push({
            ruleId: 'vibe-code.missing-import',
            title: 'Missing Import',
            description: `Module '${mod}' is used but not imported`,
            severity: 'high',
            filePath,
            line: idx + 1,
            snippet: line.trim(),
          });
        }
      }
    });

    return issues;
  }

  private detectInconsistentNaming(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    const declarations = new Map<string, string>();

    lines.forEach((line, idx) => {
      const code = this.stripCommentsAndStrings(line);
      const declMatch = code.match(/(?:const|let|var|function)\s+(\w+)/);
      if (declMatch?.[1]) {
        const name = declMatch[1];
        declarations.set(name.toLowerCase(), name);
      }

      const usageMatches = code.matchAll(/\b(\w+)\(/g);
      for (const match of usageMatches) {
        const used = match[1];
        if (!used) continue;
        const canonical = declarations.get(used.toLowerCase());
        if (canonical && canonical !== used) {
          issues.push({
            ruleId: 'vibe-code.name-mismatch',
            title: 'Inconsistent Naming',
            description: `'${used}' should be '${canonical}'`,
            severity: 'medium',
            filePath,
            line: idx + 1,
            snippet: line.trim(),
          });
        }
      }
    });

    return issues;
  }

  private detectUnhandledPromises(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check if this line starts a promise call
      const promiseCall = /(\bawait\s+)?\s*\b(fetch|axios)\s*[.(]/.exec(line);
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

      issues.push({
        ruleId: 'vibe-code.unhandled-promise',
        title: 'Unhandled Promise',
        description: 'Async operation without error handling',
        severity: 'high',
        filePath,
        line: i + 1,
        snippet: line.trim(),
      });

      i = endIdx;
    }

    return issues;
  }

  /**
   * Detect dead code after return, throw, break, continue statements
   */
  private detectDeadCode(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    // Track brace depth to handle block scope
    let braceDepth = 0;
    let afterTerminator = false;
    let terminatorLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Count braces to track scope
      for (const char of line) {
        if (char === '{') {
          braceDepth++;
          afterTerminator = false; // New block starts
        } else if (char === '}') {
          braceDepth--;
          afterTerminator = false; // Block ends
        }
      }

      // Reset afterTerminator if we hit a new case or default in a switch
      if (trimmed.startsWith('case ') || trimmed.startsWith('default:')) {
        afterTerminator = false;
      }

      // Check for terminator statements
      if (/^\s*(return|throw|break|continue)\b/.test(trimmed) && !trimmed.includes('{')) {
        afterTerminator = true;
        terminatorLine = i + 1;
        continue;
      }

      // If we're after a terminator, check for code (not braces, comments, or empty lines)
      if (afterTerminator && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && trimmed !== '}' && trimmed !== '{') {
        issues.push({
          ruleId: 'vibe-code.dead-code',
          title: 'Dead Code',
          description: `Unreachable code after line ${terminatorLine}`,
          severity: 'medium',
          filePath,
          line: i + 1,
          snippet: trimmed,
        });
        afterTerminator = false; // Report once per block
      }
    }

    return issues;
  }

  /**
   * Detect common type mismatches (basic heuristics without full AST)
   */
  private detectTypeMismatches(filePath: string, lines: string[]): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    // Track variable types from declarations
    const varTypes = new Map<string, 'string' | 'number' | 'array' | 'object' | 'unknown'>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Track type from initialization (stop at first semicolon to avoid grabbing sibling statements)
      const constMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*([^;]+)/);
      if (constMatch && constMatch[1] && constMatch[2]) {
        const varName = constMatch[1];
        const value = constMatch[2];
        if (/^['"`]/.test(value.trim())) {
          varTypes.set(varName, 'string');
        } else if (/^\d/.test(value.trim())) {
          varTypes.set(varName, 'number');
        } else if (/^\[/.test(value.trim())) {
          varTypes.set(varName, 'array');
        } else if (/^\{/.test(value.trim())) {
          varTypes.set(varName, 'object');
        }
      }

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

    // Extract all imports
    const importLines: { module: string; line: number; snippet: string }[] = [];
    const lines = content.split('\n');

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

    // Try to find and read package.json
    const packageJson = await this.findPackageJson(filePath);
    if (!packageJson) return issues;

    const allDeps = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
      ...Object.keys(packageJson.peerDependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {})
    ]);

    // Check each import against dependencies
    for (const { module: moduleName, line, snippet } of importLines) {
      if (!allDeps.has(moduleName)) {
        issues.push({
          ruleId: 'vibe-code.hallucinated-dep',
          title: 'Hallucinated Dependency',
          description: `Module '${moduleName}' is imported but not found in package.json`,
          severity: 'high',
          filePath,
          line,
          snippet,
        });
      }
    }

    return issues;
  }

  /**
   * Find and parse the nearest package.json
   */
  private async findPackageJson(filePath: string): Promise<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } | null> {
    let dir = path.dirname(filePath);
    const root = path.parse(dir).root;

    while (dir !== root) {
      const pkgPath = path.join(dir, 'package.json');
      try {
        const content = await this.readFile(pkgPath);
        return JSON.parse(content);
      } catch {
        dir = path.dirname(dir);
      }
    }

    return null;
  }
}
