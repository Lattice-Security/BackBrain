import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { TreeSitterScanner, createLogger } from '@backbrain/core';

const logger = createLogger('TreeSitterGrammarLoader');

const GRAMMAR_MAP: Record<string, string> = {
    '.js': 'tree-sitter-javascript.wasm',
    '.jsx': 'tree-sitter-javascript.wasm',
    '.ts': 'tree-sitter-typescript.wasm',
    '.tsx': 'tree-sitter-tsx.wasm',
};

export async function loadTreeSitterGrammars(
    scanner: TreeSitterScanner,
    extensionUri: vscode.Uri,
): Promise<void> {
    const distUri = vscode.Uri.joinPath(extensionUri, 'dist');

    // Initialize the WASM runtime so Language.load() works
    await Parser.init({
        locateFile: (file: string) => vscode.Uri.joinPath(distUri, file).fsPath,
    });

    for (const [ext, wasmFile] of Object.entries(GRAMMAR_MAP)) {
        try {
            const wasmPath = vscode.Uri.joinPath(distUri, wasmFile).fsPath;
            const lang = await Parser.Language.load(wasmPath);
            (scanner as unknown as { languages: Map<string, Parser.Language> }).languages.set(ext, lang);
            logger.info(`Loaded ${wasmFile} for extension ${ext}`);
        } catch (error) {
            logger.warn(`Failed to load ${wasmFile} for extension ${ext}`, { error });
        }
    }
}
