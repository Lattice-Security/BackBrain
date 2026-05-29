import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KNOWLEDGE_DIR = join(__dirname, '../knowledge');

const EMERGING_TRENDS_FILE = join(
  KNOWLEDGE_DIR,
  'emerging_security_paradigms_and_threat_horizons_in_ai_generated_and_agent_assisted_codebases_a_2026_technical_threat_intelligence_report_V3.json',
);
const VULNERABILITY_CATALOG_FILE = join(
  KNOWLEDGE_DIR,
  'empirical_analysis_of_vulnerability_propagation_in_ai_generated_and_ai_assisted_source_code_V2.json',
);

export interface KnowledgeContext {
  trends: string;
  vulnerabilityCatalog: string;
}

function formatTrendsSection(data: any): string {
  const lines: string[] = ['--- Emerging Trends in AI-Generated Code Security ---'];
  if (data.landscape_summary) {
    lines.push('');
    lines.push(`Landscape: ${data.landscape_summary}`);
    lines.push('');
  }
  if (Array.isArray(data.trends)) {
    for (const t of data.trends.slice(0, 20)) {
      lines.push(`- ${t.id}: ${t.title} [${t.status}]`);
      lines.push(`  Severity trajectory: ${t.severity_trajectory}`);
      lines.push(`  Affects: ${formatAffects(t.affects)}`);
      lines.push(`  Description: ${t.description?.split('.')[0]}.`);
      if (t.scanner_implication) {
        lines.push(`  Scanner: ${t.scanner_implication}`);
      }
      lines.push('');
    }
  }
  if (Array.isArray(data.emerging_attack_classes)) {
    lines.push('--- Emerging Attack Classes ---');
    for (const a of data.emerging_attack_classes) {
      lines.push(`- ${a.id}: ${a.title}`);
      lines.push(`  Description: ${a.description?.split('.')[0]}.`);
      lines.push(`  Mitigation: ${a.mitigation_strategy?.split('.')[0]}.`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function formatAffects(affects: any): string {
  if (!affects) return 'N/A';
  const parts: string[] = [];
  if (affects.languages) parts.push(`lang:${affects.languages.join(',')}`);
  if (affects.app_types) parts.push(`app:${affects.app_types.join(',')}`);
  if (affects.frameworks) parts.push(`fw:${affects.frameworks.join(',')}`);
  if (affects.ai_tools_implicated) parts.push(`tools:${affects.ai_tools_implicated.join(',')}`);
  return parts.join('; ') || 'N/A';
}

function formatVulnerabilitySection(data: any): string {
  const lines: string[] = ['--- AI-Generated Vulnerability Catalog ---'];
  if (data.metadata) {
    lines.push(`Source date range: ${data.metadata.source_date_range}`);
    lines.push('');
  }
  if (Array.isArray(data.findings)) {
    for (const f of data.findings) {
      lines.push(`- ${f.id}: ${f.title} [${f.severity}] (${f.finding_type})`);
      lines.push(`  Affects: ${formatAffects(f.affects)}`);
      lines.push(`  Description: ${f.description?.split('.')[0]}.`);
      if (Array.isArray(f.detection_signals) && f.detection_signals.length > 0) {
        lines.push(`  Detection signals:`);
        for (const sig of f.detection_signals.slice(0, 3)) {
          lines.push(`    - ${sig}`);
        }
      }
      if (f.code_pattern) {
        const snippet = f.code_pattern.split('\n').slice(0, 3).join('; ');
        lines.push(`  Pattern: ${snippet}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function loadKnowledge(): KnowledgeContext | null {
  try {
    const trendsRaw = JSON.parse(readFileSync(EMERGING_TRENDS_FILE, 'utf-8'));
    const catalogRaw = JSON.parse(readFileSync(VULNERABILITY_CATALOG_FILE, 'utf-8'));
    return {
      trends: formatTrendsSection(trendsRaw),
      vulnerabilityCatalog: formatVulnerabilitySection(catalogRaw),
    };
  } catch {
    return null;
  }
}

export function formatKnowledgeBlock(knowledge: KnowledgeContext): string {
  return [
    'Security intelligence context from external research:',
    '',
    knowledge.trends,
    '',
    knowledge.vulnerabilityCatalog,
    '',
    'Use this intelligence when deciding which specialists to create and what checks they should perform.',
    'Prioritize scanning for patterns listed in the detection signals above.',
  ].join('\n');
}
