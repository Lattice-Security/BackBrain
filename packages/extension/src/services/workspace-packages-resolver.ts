import * as path from 'path';
import * as fs from 'fs';

let cachedWorkspacePackages: Set<string> | null = null;

/**
 * Resolve all internal workspace package names (e.g. "@backbrain/core")
 * by reading the root package.json workspaces field and each workspace
 * member's package.json name field. Also checks root tsconfig.json paths
 * for any aliases that map to workspace packages.
 *
 * Returns a Set of package names that are internal and should be excluded
 * from hallucinated dependency checks.
 */
export async function getWorkspacePackageNames(workspaceRoot: string): Promise<Set<string>> {
    if (cachedWorkspacePackages) return cachedWorkspacePackages;

    const names = new Set<string>();

    // 1. Read root package.json for workspaces field
    const rootPkgPath = path.join(workspaceRoot, 'package.json');
    let rootPkg: any;
    try {
        rootPkg = JSON.parse(await fs.promises.readFile(rootPkgPath, 'utf-8'));
    } catch {
        // Fail open: if we can't read the root manifest, return empty set
        cachedWorkspacePackages = names;
        return names;
    }

    const workspaces: string[] = rootPkg.workspaces;
    if (!workspaces || !Array.isArray(workspaces)) {
        cachedWorkspacePackages = names;
        return names;
    }

    // 2. Resolve glob patterns (only simple globs like packages/*)
    //    to find each workspace member and read its package.json name
    for (const pattern of workspaces) {
        // Convert simple glob to directory listing
        const globDir = pattern.replace('*', '');
        const fullGlobDir = path.join(workspaceRoot, globDir);
        try {
            const entries = await fs.promises.readdir(fullGlobDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const pkgJsonPath = path.join(fullGlobDir, entry.name, 'package.json');
                    try {
                        const pkg = JSON.parse(await fs.promises.readFile(pkgJsonPath, 'utf-8'));
                        if (pkg.name) {
                            names.add(pkg.name);
                        }
                    } catch {
                        // Skip packages without readable package.json
                    }
                }
            }
        } catch {
            // Skip unreadable glob directories
        }
    }

    // 3. Check root tsconfig.json paths for aliases pointing to workspace packages
    const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
    try {
        const tsconfig = JSON.parse(await fs.promises.readFile(tsconfigPath, 'utf-8'));
        const paths = tsconfig.compilerOptions?.paths;
        if (paths && typeof paths === 'object') {
            for (const [alias, resolutions] of Object.entries(paths) as [string, string[]][]) {
                const cleanAlias = alias.replace(/\/\*$/, '');
                if (names.has(cleanAlias)) continue; // already known
                for (const resolution of resolutions) {
                    const cleanResolution = resolution.replace(/\/\*$/, '');
                    const resolvedPath = path.resolve(workspaceRoot, cleanResolution);
                    // Walk up from resolution to find the nearest package.json
                    let dir = resolvedPath;
                    const root = path.parse(dir).root;
                    while (dir !== root) {
                        const pkgCandidate = path.join(dir, 'package.json');
                        try {
                            const pkg = JSON.parse(await fs.promises.readFile(pkgCandidate, 'utf-8'));
                            if (pkg.name && names.has(pkg.name)) {
                                names.add(cleanAlias);
                            }
                            break;
                        } catch {
                            dir = path.dirname(dir);
                        }
                    }
                }
            }
        }
    } catch {
        // No tsconfig.json or unreadable — skip aliases
    }

    cachedWorkspacePackages = names;
    return names;
}

/**
 * Filter out hallucinated dependency issues for known workspace packages.
 * Only affects issues with ruleId starting with 'vibe-code.hallucinated-dep'.
 */
export function filterWorkspaceHallucinatedDeps<T extends { ruleId?: string; description?: string }>(
    issues: T[],
    workspacePackageNames: Set<string>,
): T[] {
    return issues.filter(issue => {
        if (!issue.ruleId || !issue.ruleId.startsWith('vibe-code.hallucinated-dep')) {
            return true;
        }
        // Extract the module name from the description: "Module 'xxx' is imported but not found..."
        const match = issue.description?.match(/Module '([^']+)'/);
        if (!match || !match[1]) return true;
        const moduleName = match[1];
        // Suppress if it's a known workspace package
        if (workspacePackageNames.has(moduleName)) {
            return false;
        }
        return true;
    });
}

/** Reset cache for testing */
export function _resetWorkspacePackageCache(): void {
    cachedWorkspacePackages = null;
}
