import { scanCommand, type ScanArgs } from './commands/scan';
import { statusCommand } from './commands/status';
import { historyCommand } from './commands/history';

function printHelp(): void {
    console.log(`
Usage: backbrain <command> [options]

Commands:
  scan        Run a security scan on the current workspace
  status      Show the last scan result summary
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

History options:
  -n, --count <num>   Number of recent entries to show (default: 10)

Examples:
  backbrain scan
  backbrain scan --json
  backbrain scan --min-severity high
  backbrain scan --changed
  backbrain status
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
    return {
        dir: extractFlag(argv, '--dir') || process.cwd(),
        json: argv.includes('--json'),
        minSeverity: extractFlag(argv, '--min-severity') as ScanArgs['minSeverity'],
        changed: argv.includes('--changed'),
        verbose: argv.includes('--verbose'),
        noAgent: argv.includes('--no-agent'),
        noSave: argv.includes('--no-save'),
        scanners: extractFlag(argv, '--scanners')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    };
}

function extractFlag(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index >= 0 && index + 1 < argv.length) {
        return argv[index + 1];
    }
    return undefined;
}
