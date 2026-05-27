import { SemgrepScanner } from './semgrep-scanner';
import { VibeCodeScanner } from './vibe-code-scanner';
import { TreeSitterScanner } from './tree-sitter-scanner';
import { GitleaksScanner } from './gitleaks-scanner';
import { TrivyScanner } from './trivy-scanner';
import { OSVScanner } from './osv-scanner';

export * from './semgrep-scanner';
export * from './vibe-code-scanner';
export * from './tree-sitter-scanner';
export * from './gitleaks-scanner';
export * from './trivy-scanner';
export * from './osv-scanner';
export * from './cli-agent-review-scanner';
export {
    InProcessAgentReviewScanner,
    type InProcessAgentReviewScannerOptions,
} from './in-process-agent-review-scanner';
export * from './vercel-ai-adapter';

export const DEFAULT_SCANNERS = [
    { name: 'semgrep', scanner: new SemgrepScanner() },
    { name: 'gitleaks', scanner: new GitleaksScanner() },
    { name: 'trivy', scanner: new TrivyScanner() },
    { name: 'osv-scanner', scanner: new OSVScanner() },
    { name: 'vibe-code', scanner: new VibeCodeScanner() },
    { name: 'tree-sitter', scanner: new TreeSitterScanner() },
];
