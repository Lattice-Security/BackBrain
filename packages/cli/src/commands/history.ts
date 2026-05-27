import { ScanResultStore } from '@backbrain/core';

export interface HistoryArgs {
    dir: string;
    count: number;
}

export async function historyCommand(args: HistoryArgs): Promise<void> {
    const store = new ScanResultStore(args.dir);
    const entries = await store.listHistory();

    if (entries.length === 0) {
        console.log('No scan history found.');
        console.log('Run "backbrain scan" first.');
        return;
    }

    const limit = Math.min(args.count, entries.length);
    console.log('');
    console.log(`Scan history (last ${limit} of ${entries.length}):`);
    console.log('\u2500'.repeat(60));

    for (let i = 0; i < limit; i++) {
        const entry = entries[i]!;
        const date = new Date(entry.timestamp);
        console.log(`  ${date.toLocaleString()}  [${entry.scanId}]  ${entry.total} issue(s)`);
    }
    console.log('');
}
