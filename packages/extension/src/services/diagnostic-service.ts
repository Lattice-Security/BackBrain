import * as vscode from 'vscode';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
  info: vscode.DiagnosticSeverity.Information,
};

export interface DiagnosticIssue {
  title: string;
  description: string;
  severity: string;
  filePath: string;
  line: number;
  column?: number;
  endLine?: number;
}

export class DiagnosticService {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('backbrain');
  }

  updateFileDiagnostics(filePath: string, issues: DiagnosticIssue[]): void {
    const uri = vscode.Uri.file(filePath);
    const diagnostics = issues.map(issue => {
      const line = Math.max(0, issue.line - 1);
      const startCol = Math.max(0, (issue.column || 1) - 1);
      const endLine = issue.endLine ? Math.max(0, issue.endLine - 1) : line;
      const range = new vscode.Range(
        new vscode.Position(line, startCol),
        new vscode.Position(endLine, 1000),
      );
      const diagnostic = new vscode.Diagnostic(
        range,
        `[${issue.severity.toUpperCase()}] ${issue.title} — ${issue.description}`,
        SEVERITY_MAP[issue.severity] ?? vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = 'BackBrain';
      return diagnostic;
    });
    this.collection.set(uri, diagnostics);
  }

  updateDiagnostics(issuesByFile: Map<string, DiagnosticIssue[]>): void {
    for (const [filePath, issues] of issuesByFile) {
      this.updateFileDiagnostics(filePath, issues);
    }
  }

  clearFile(filePath: string): void {
    this.collection.delete(vscode.Uri.file(filePath));
  }

  clearAll(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
