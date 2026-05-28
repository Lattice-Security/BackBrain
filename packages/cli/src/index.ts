import { scanCommand, type ScanArgs } from './commands/scan';
import { statusCommand } from './commands/status';
import { historyCommand } from './commands/history';
import { fixCommand, type FixArgs } from './commands/fix';

function printHelp(): void {
    console.log(`
Usage: backbrain <command> [options]

Commands:
  scan        Run a security scan on the current workspace
  status      Show the last scan result summary
  fix         Apply fixes from the last scan
  history     List recent scan history entries

Scan options:
  --json              Output full results as JSON to stdout
  --min-severity <s>  Minimum severity (critical|high|medium|low|info)
  --changed           Only scan git-changed files (vs HEAD)
  --dir <path>        Workspace root directory (default: cwd)
  --verbose           Enable debug-level logging
  --no-agent          Skip AI agent review scanners
  --no-save           Skip writing .backbrain/ result files
  --scanners <list>   Comma-separated scanner names to use
  --fix               After scan, apply safe auto-fixes automatically
  --fix-all           After scan, apply all fixes (including non-autoFixable)
  --commit            After scan + fix, git commit if all issues resolved
  --opencode-model <m>  Model override for OpenCode (format: provider/model)
  --opencode-variant <v>  Reasoning effort for OpenCode (high, max, minimal)

Fix options:
  --all               Apply all fixes (including non-autoFixable)
  --issue <id>        Apply a specific fix by issue ID
  --dry-run           Show what would change without modifying files
  --revert <id>       Revert a previous fix session
  --scan <id>         Use a specific scan result (default: latest)
  --json              Output full results as JSON to stdout

History options:
  -n, --count <num>   Number of recent entries to show (default: 10)

Examples:
  backbrain scan
  backbrain scan --json
  backbrain scan --fix
  backbrain scan --fix --commit
  backbrain scan --min-severity high
  backbrain scan --changed
  backbrain scan --opencode-model anthropic/claude-sonnet-4-20250514 --opencode-variant high
  backbrain status
  backbrain fix
  backbrain fix --dry-run
  backbrain fix --issue sec-abc123
  backbrain fix --revert session-1-12345
  backbrain history -n 5
`);
}

export async function main(argv: string[]): Promise<void> {
    const command = argv[0];

    if (!command || command === '--help' || command === '-h') {
        printHelp();
        return;
    }

    switch (command) {
        case 'scan': {
            const args = parseScanArgs(argv.slice(1));
            const exitCode = await scanCommand(args);
            process.exit(exitCode);
        }
        case 'status': {
            const dir = extractFlag(argv.slice(1), '--dir') || process.cwd();
            const verbose = argv.includes('--verbose');
            await statusCommand({ dir, verbose });
            break;
        }
        case 'fix': {
            const args = parseFixArgs(argv.slice(1));
            const exitCode = await fixCommand(args);
            process.exit(exitCode);
        }
        case 'history': {
            const dir = extractFlag(argv.slice(1), '--dir') || process.cwd();
            const countStr = extractFlag(argv.slice(1), '-n') || extractFlag(argv.slice(1), '--count');
            const count = countStr ? parseInt(countStr, 10) : 10;
            await historyCommand({ dir, count });
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            printHelp();
            process.exit(1);
    }
}

function parseScanArgs(argv: string[]): ScanArgs {
    const minSev = extractFlag(argv, '--min-severity');
    const scn = extractFlag(argv, '--scanners');
    return {
        dir: extractFlag(argv, '--dir') || process.cwd(),
        json: argv.includes('--json'),
        minSeverity: minSev ?? undefined,
        changed: argv.includes('--changed'),
        verbose: argv.includes('--verbose'),
        noAgent: argv.includes('--no-agent'),
        noSave: argv.includes('--no-save'),
        scanners: scn
            ? scn.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
        fix: argv.includes('--fix') || argv.includes('--fix-all'),
        fixAll: argv.includes('--fix-all'),
        commit: argv.includes('--commit'),
        opencodeModel: extractFlag(argv, '--opencode-model') ?? undefined,
        opencodeVariant: extractFlag(argv, '--opencode-variant') ?? undefined,
    };
}

function parseFixArgs(argv: string[]): FixArgs {
    return {
        dir: extractFlag(argv, '--dir') || process.cwd(),
        issueId: extractFlag(argv, '--issue') ?? undefined,
        all: argv.includes('--all'),
        dryRun: argv.includes('--dry-run'),
        revert: extractFlag(argv, '--revert') ?? undefined,
        scanId: extractFlag(argv, '--scan') ?? undefined,
        json: argv.includes('--json'),
        verbose: argv.includes('--verbose'),
    };
}

function extractFlag(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index >= 0 && index + 1 < argv.length) {
        return argv[index + 1];
    }
    return undefined;
}

if (import.meta?.main ?? true) {
    main(process.argv.slice(2)).catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
