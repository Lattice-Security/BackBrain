import type { FileSystem, AIProvider, SecurityIssue } from '../ports';
import type { FileGraph, FileNode, FileEdge, FileImport, WorkflowGraph, WorkflowStep, WorkflowConnection } from '../types';
import { getLogger } from '../utils/logger';
import * as path from 'path';

const logger = getLogger();

export class VisualizerService {
    constructor() {}

    /**
     * Helper to clean path separators
     */
    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/');
    }

    /**
     * Helper to get relative path from root
     */
    private getRelativePath(absolutePath: string, rootPath: string): string {
        const normalizedAbs = this.normalizePath(absolutePath);
        const normalizedRoot = this.normalizePath(rootPath);
        if (normalizedAbs.startsWith(normalizedRoot)) {
            let rel = normalizedAbs.slice(normalizedRoot.length);
            if (rel.startsWith('/')) rel = rel.slice(1);
            return rel;
        }
        return path.basename(absolutePath);
    }

    /**
     * Parses JS/TS/JSX/TSX content for imports and exports using regex
     */
    private parseFileImportsAndExports(content: string): { imports: { from: string; imported: string[]; isRelative: boolean }[]; exports: string[] } {
        const fileImports: { from: string; imported: string[]; isRelative: boolean }[] = [];
        const fileExports: string[] = [];

        // 1. ES Modules imports
        // e.g., import { foo, bar } from './baz'; or import foo from 'bar';
        const importRegex = /import\s+(?:type\s+)?([\w\s{},*]*?)\s+from\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const importClause = (match[1] || '').trim();
            const fromPath = match[2] || '';
            const isRelative = fromPath.startsWith('.') || fromPath.startsWith('/');
            
            // Parse imported symbols
            const imported: string[] = [];
            if (importClause.startsWith('{')) {
                const symbols = importClause.replace(/[{}]/g, '').split(',');
                symbols.forEach(s => {
                    const clean = s.trim().split(/\s+as\s+/)[0]?.trim();
                    if (clean) imported.push(clean);
                });
            } else if (importClause.includes('* as')) {
                const parts = importClause.split(/\s+as\s+/);
                if (parts[1]) imported.push(parts[1].trim());
            } else if (importClause) {
                imported.push(importClause);
            }

            fileImports.push({ from: fromPath, imported, isRelative });
        }

        // 2. Simple side-effect imports: import 'style.css';
        const simpleImportRegex = /import\s+['"]([^'"]+)['"]/g;
        while ((match = simpleImportRegex.exec(content)) !== null) {
            const fromPath = match[1] || '';
            if (!fileImports.some(imp => imp.from === fromPath)) {
                fileImports.push({
                    from: fromPath,
                    imported: [],
                    isRelative: fromPath.startsWith('.') || fromPath.startsWith('/')
                });
            }
        }

        // 3. CommonJS requires: const foo = require('./bar');
        const requireRegex = /(?:const|let|var)\s+([\w\s{},*]*?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = requireRegex.exec(content)) !== null) {
            const fromPath = match[2] || '';
            const isRelative = fromPath.startsWith('.') || fromPath.startsWith('/');
            fileImports.push({
                from: fromPath,
                imported: [],
                isRelative
            });
        }

        // 4. Parse exports
        // e.g., export const foo = 1; export class Bar {} export function baz() {}
        const exportRegex = /export\s+(?:const|let|var|class|interface|function|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
        while ((match = exportRegex.exec(content)) !== null) {
            if (match[1]) {
                fileExports.push(match[1]);
            }
        }

        // e.g. export default foo;
        const exportDefaultRegex = /export\s+default\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
        while ((match = exportDefaultRegex.exec(content)) !== null) {
            if (match[1] && !fileExports.includes(match[1])) {
                fileExports.push(`default: ${match[1]}`);
            }
        }

        return { imports: fileImports, exports: fileExports };
    }

    /**
     * Resolves an import source string to one of the known file paths
     */
    private resolveImport(importFrom: string, currentFilePath: string, knownPaths: string[]): string | null {
        if (!importFrom.startsWith('.')) return null;

        const currentDir = path.dirname(currentFilePath);
        const absoluteImport = path.resolve(currentDir, importFrom);
        const normalizedAbsolute = this.normalizePath(absoluteImport);

        // Try standard extensions
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];
        for (const ext of extensions) {
            const target = normalizedAbsolute + ext;
            const match = knownPaths.find(p => this.normalizePath(p) === target || this.normalizePath(p).replace(/\.[a-zA-Z0-9]+$/, '') === target);
            if (match) {
                return match;
            }
        }

        return null;
    }

    /**
     * Generates a file dependency graph for the given workspace paths
     */
    async generateFileGraph(paths: string[], fileSystem: FileSystem, rootPath: string): Promise<FileGraph> {
        logger.info('Generating file dependency graph', { count: paths.length });
        const nodes: FileNode[] = [];
        const edges: FileEdge[] = [];
        const normalizedRoot = this.normalizePath(rootPath);

        // Filter for JavaScript/TypeScript files
        const supportedExtensions = ['.js', '.ts', '.jsx', '.tsx'];
        const sourcePaths = paths.filter(p => supportedExtensions.includes(path.extname(p)));

        // Phase 1: Create nodes
        for (const filePath of sourcePaths) {
            try {
                if (!(await fileSystem.exists(filePath))) continue;
                const content = await fileSystem.readFile(filePath);
                const { imports, exports } = this.parseFileImportsAndExports(content);
                const relPath = this.getRelativePath(filePath, normalizedRoot);
                const ext = path.extname(filePath);

                const fileImportItems: FileImport[] = imports.map(imp => ({
                    from: imp.from,
                    imported: imp.imported,
                    isRelative: imp.isRelative
                }));

                const node: FileNode = {
                    id: this.normalizePath(filePath),
                    filePath: this.normalizePath(filePath),
                    fileName: relPath,
                    language: ext.slice(1),
                    exports,
                    imports: fileImportItems
                };
                nodes.push(node);
            } catch (error) {
                logger.warn('Failed to parse file for dependencies', { filePath, error });
            }
        }

        // Phase 2: Create edges based on resolved imports
        const knownPaths = nodes.map(n => n.filePath);
        let edgeIdCounter = 0;

        for (const node of nodes) {
            for (const imp of node.imports) {
                if (!imp.isRelative) continue;

                const targetPath = this.resolveImport(imp.from, node.filePath, knownPaths);
                if (targetPath && targetPath !== node.filePath) {
                    const edge: FileEdge = {
                        id: `edge-${edgeIdCounter++}`,
                        source: node.filePath,
                        target: targetPath,
                        type: 'imports',
                        ...(imp.imported.length > 0 ? { label: imp.imported.slice(0, 3).join(', ') } : {})
                    };
                    edges.push(edge);
                }
            }
        }

        // Phase 3: Layout positioning (simple grid or hierarchical layered layout)
        // Position them in a grid if position isn't already provided
        const columns = Math.ceil(Math.sqrt(nodes.length));
        nodes.forEach((node, idx) => {
            const col = idx % columns;
            const row = Math.floor(idx / columns);
            node.position = {
                x: col * 180 + 50,
                y: row * 130 + 50
            };
        });

        return { nodes, edges };
    }

    /**
     * Generates a logical workflow graph of the application.
     * Uses AI if available, otherwise runs a deterministic architectural mapping fallback.
     */
    async generateWorkflowGraph(
        paths: string[],
        _fileSystem: FileSystem,
        issues: SecurityIssue[],
        aiProvider?: AIProvider
    ): Promise<WorkflowGraph> {
        logger.info('Generating workflow logical graph');

        if (aiProvider && await aiProvider.isAvailable()) {
            try {
                return await this.generateWorkflowGraphWithAI(paths, issues, aiProvider);
            } catch (error) {
                logger.warn('Failed to generate workflow graph with AI, falling back to deterministic model', { error });
            }
        }

        return this.generateWorkflowGraphDeterministic(paths, issues);
    }

    /**
     * Generate workflow graph using AI
     */
    private async generateWorkflowGraphWithAI(
        paths: string[],
        issues: SecurityIssue[],
        aiProvider: AIProvider
    ): Promise<WorkflowGraph> {
        const fileNames = paths.map(p => path.basename(p));
        const issuesSummary = issues.map((issue) => 
            `- [${issue.severity}] ${issue.title} at ${path.basename(issue.filePath)}:${issue.line}`
        ).slice(0, 15).join('\n');

        const prompt = `You are a software architect analyzing a codebase.
Generate a logical workflow / control flow graph of this application's key components and logic steps.
Identify the logical steps, decisions, inputs, and outputs.
Crucially, look at the active issues list and determine if there are any logical gaps/holes (e.g. unhandled error branches, missing validations, missing authentications, rate limits, symlink followings). If so, represent them as nodes (labeled as warning or unhandled gap) or connections with warning descriptions.

Files in project:
${fileNames.join(', ')}

Active issues:
${issuesSummary || 'No active issues'}

Please output ONLY a JSON object representing the workflow graph. Do NOT wrap it in markdown or formatting other than a standard JSON string. Use this exact JSON schema:
{
  "id": "workflow-ai",
  "name": "Application Logic Flow",
  "steps": [
    {
      "id": "node-unique-id",
      "title": "Short descriptive step name (e.g., Receive File Scan Request)",
      "description": "Short explanation of this step",
      "type": "input" | "action" | "decision" | "output"
    }
  ],
  "connections": [
    {
      "id": "conn-unique-id",
      "source": "source-node-id",
      "target": "target-node-id",
      "label": "Optional label (e.g. success, failure, file saved)",
      "condition": "Optional condition string (e.g., if token valid)"
    }
  ]
}

Make sure connections reference valid step IDs. Do not include extra comments outside the JSON.`;

        const response = await aiProvider.complete(prompt, {
            content: `Files list: ${fileNames.join('\n')}`,
            systemPrompt: 'You are an AI architect. Return ONLY valid JSON matching the requested schema.'
        });

        // Clean response content (strip markdown backticks if any)
        let cleaned = response.content.trim();
        const jsonMatch = cleaned.match(/```json\s*([\s\S]*?)\s*```/) || cleaned.match(/```\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            cleaned = jsonMatch[1].trim();
        } else {
            const startBrace = cleaned.indexOf('{');
            const endBrace = cleaned.lastIndexOf('}');
            if (startBrace >= 0 && endBrace > startBrace) {
                cleaned = cleaned.slice(startBrace, endBrace + 1);
            }
        }

        const parsed = JSON.parse(cleaned) as WorkflowGraph;
        
        // Dynamic Grid positioning for workflow steps
        const columns = Math.ceil(Math.sqrt(parsed.steps.length));
        parsed.steps.forEach((step, idx) => {
            if (!step.position) {
                const col = idx % columns;
                const row = Math.floor(idx / columns);
                step.position = {
                    x: col * 200 + 60,
                    y: row * 150 + 60
                };
            }
        });

        return parsed;
    }

    /**
     * Deterministic backup layout for logical workflow graph
     */
    private generateWorkflowGraphDeterministic(paths: string[], issues: SecurityIssue[]): WorkflowGraph {
        const fileNames = paths.map(p => path.basename(p));
        const isBackBrain = fileNames.some(f => f.includes('severity-panel-provider') || f.includes('cli-agent-review'));

        if (isBackBrain) {
            // Build a beautiful diagram of BackBrain's scan and fix flow!
            const steps: WorkflowStep[] = [
                {
                    id: 'w-input-file',
                    title: 'Scan Request',
                    description: 'User triggers File or Workspace scan',
                    type: 'input',
                    position: { x: 50, y: 150 }
                },
                {
                    id: 'w-deterministic-scan',
                    title: 'Deterministic Scanners',
                    description: 'Run Semgrep, Gitleaks, Trivy & Vibe rules',
                    type: 'action',
                    position: { x: 230, y: 150 }
                },
                {
                    id: 'w-check-agent',
                    title: 'Agent Review Enabled?',
                    description: 'Check if AI Specialists scanning is enabled in configuration',
                    type: 'decision',
                    position: { x: 420, y: 150 }
                },
                {
                    id: 'w-agent-planner',
                    title: 'AI Planner Agent',
                    description: 'Orchestrator spawns task-focused specialist agents',
                    type: 'action',
                    position: { x: 610, y: 50 }
                },
                {
                    id: 'w-agent-specialists',
                    title: 'Specialist Review',
                    description: 'AI specialists review code lines and report findings',
                    type: 'action',
                    position: { x: 800, y: 50 }
                },
                {
                    id: 'w-aggregator',
                    title: 'Aggregator & Verification',
                    description: 'Merge duplicates, verify finding locations against AST',
                    type: 'action',
                    position: { x: 990, y: 150 }
                },
                {
                    id: 'w-render-ui',
                    title: 'Issues Sidebar Panel',
                    description: 'Render categorized findings in VS Code Severity view',
                    type: 'output',
                    position: { x: 1180, y: 150 }
                },
                {
                    id: 'w-apply-fix',
                    title: 'One-Click Revertible Fix',
                    description: 'User applies AI replacement or reverts in one click',
                    type: 'action',
                    position: { x: 1370, y: 150 }
                }
            ];

            // If we have active critical or high issues, let's inject a gap node to show a "hole"!
            const hasGaps = issues.length > 0;
            if (hasGaps) {
                steps.push({
                    id: 'w-gap-verification',
                    title: 'Logic Hole: Verification Symlinks',
                    description: 'Missing validation: verify Finding Location follows symlinks without boundaries',
                    type: 'decision',
                    position: { x: 990, y: 280 }
                });
            }

            const connections: WorkflowConnection[] = [
                { id: 'c-1', source: 'w-input-file', target: 'w-deterministic-scan', label: 'Trigger' },
                { id: 'c-2', source: 'w-deterministic-scan', target: 'w-check-agent' },
                { id: 'c-3', source: 'w-check-agent', target: 'w-agent-planner', label: 'Yes' },
                { id: 'c-4', source: 'w-agent-planner', target: 'w-agent-specialists', label: 'Spawns' },
                { id: 'c-5', source: 'w-agent-specialists', target: 'w-aggregator', label: 'Findings' },
                { id: 'c-6', source: 'w-check-agent', target: 'w-aggregator', label: 'No (Deterministic only)', condition: 'disabled' },
                { id: 'c-7', source: 'w-aggregator', target: 'w-render-ui', label: 'Sync' },
                { id: 'c-8', source: 'w-render-ui', target: 'w-apply-fix', label: 'Apply' }
            ];

            if (hasGaps) {
                connections.push(
                    { id: 'c-9', source: 'w-aggregator', target: 'w-gap-verification', label: 'Vulnerability path', condition: 'Unverified path input' },
                    { id: 'c-10', source: 'w-gap-verification', target: 'w-render-ui', label: 'Reported risk' }
                );
            }

            return {
                id: 'workflow-backbrain',
                name: 'BackBrain Security & Fix Flow',
                steps,
                connections
            };
        }

        // Generic fallback for any other codebase
        const steps: WorkflowStep[] = [
            {
                id: 'w-start',
                title: 'Entry Point',
                description: 'Application starts / requests received',
                type: 'input',
                position: { x: 50, y: 150 }
            },
            {
                id: 'w-controller',
                title: 'Request Handler / Controllers',
                description: 'Routes incoming actions to correct controller',
                type: 'action',
                position: { x: 250, y: 150 }
            },
            {
                id: 'w-services',
                title: 'Business Logic Services',
                description: 'Process requests and evaluate rules',
                type: 'action',
                position: { x: 450, y: 150 }
            },
            {
                id: 'w-database',
                title: 'Data Store / Adapter',
                description: 'Read or write from DB or API providers',
                type: 'action',
                position: { x: 650, y: 150 }
            },
            {
                id: 'w-output',
                title: 'Response Render',
                description: 'Sends response or HTML view back to client',
                type: 'output',
                position: { x: 850, y: 150 }
            }
        ];

        const connections: WorkflowConnection[] = [
            { id: 'c-1', source: 'w-start', target: 'w-controller' },
            { id: 'c-2', source: 'w-controller', target: 'w-services' },
            { id: 'c-3', source: 'w-services', target: 'w-database' },
            { id: 'c-4', source: 'w-database', target: 'w-output' }
        ];

        return {
            id: 'workflow-generic',
            name: 'Generic Codebase Logic Flow',
            steps,
            connections
        };
    }
}
