const NAVIGATION_COOLDOWN_MS = 2000;
const _navigatedFiles = new Set<string>();
let _cooldownTimers: ReturnType<typeof setTimeout>[] = [];

export function markFileAsNavigated(filePath: string): void {
    _navigatedFiles.add(filePath);
    const timer = setTimeout(() => {
        _navigatedFiles.delete(filePath);
    }, NAVIGATION_COOLDOWN_MS);
    _cooldownTimers.push(timer);
}

export function isRecentlyNavigated(filePath: string): boolean {
    return _navigatedFiles.has(filePath);
}

export function clearAllCooldowns(): void {
    _navigatedFiles.clear();
    for (const timer of _cooldownTimers) {
        clearTimeout(timer);
    }
    _cooldownTimers = [];
}
