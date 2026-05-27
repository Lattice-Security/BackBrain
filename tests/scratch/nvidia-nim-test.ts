/**
 * Live integration test: NVIDIA NIM DeepSeek via the OpenAI-compatible endpoint.
 *
 * Run with:
 *   bun run tests/scratch/nvidia-nim-test.ts
 */

import { VercelAIAdapter, AIAnalysisService } from '../../packages/core/src/index';
import type { SecurityIssue } from '../../packages/core/src/ports';

const API_KEY = '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';
const MODEL   = 'deepseek-ai/deepseek-r1';
const BASE_URL = 'https://integrate.api.nvidia.com/v1';

// A realistic security issue for the test
const testIssue: SecurityIssue = {
    ruleId:      'python.django.security.audit.unvalidated-redirect',
    title:       'Unvalidated Redirect',
    description: 'User-controlled data is used in a redirect without validation, allowing open redirect attacks.',
    severity:    'high',
    filePath:    'app/views.py',
    line:        42,
    snippet:     `redirect_url = request.GET.get('next', '/')
return HttpResponseRedirect(redirect_url)`,
};

async function main() {
    console.log('='.repeat(60));
    console.log('NVIDIA NIM DeepSeek Integration Test');
    console.log(`Model    : ${MODEL}`);
    console.log(`Endpoint : ${BASE_URL}`);
    console.log('='.repeat(60));

    // Wire up the adapter pointing directly at NVIDIA NIM
    const adapter = new VercelAIAdapter({
        provider: 'openai',   // NIM is OpenAI-compatible
        model:    MODEL,
        apiKey:   API_KEY,
        baseUrl:  BASE_URL,
    });

    const service = new AIAnalysisService(adapter);

    // ── 1. Availability check ────────────────────────────────────────────────
    const available = await service.isAvailable();
    console.log(`\n[1] isAvailable() → ${available}`);
    if (!available) {
        console.error('Adapter reports not available. Check API key / config.');
        process.exit(1);
    }

    // ── 2. Explain Issue ─────────────────────────────────────────────────────
    console.log('\n[2] Calling explainIssue() …');
    try {
        const explanation = await service.explainIssue(testIssue);
        console.log('\n--- Explanation ---');
        console.log(explanation);
        console.log('--- End ---\n');
        console.log('[2] explainIssue(): PASSED');
    } catch (err: any) {
        console.error('[2] explainIssue(): FAILED');
        console.error(`    ${err.message ?? err}`);
        process.exit(1);
    }

    // ── 3. Suggest Fix ───────────────────────────────────────────────────────
    console.log('\n[3] Calling suggestFix() …');
    try {
        const fix = await service.suggestFix(testIssue);
        console.log('\n--- Suggested Fix ---');
        console.log(`Description : ${fix.description}`);
        console.log(`Auto-fixable: ${fix.autoFixable}`);
        console.log(`Replacement :\n${fix.replacement}`);
        console.log('--- End ---\n');
        console.log('[3] suggestFix(): PASSED');
    } catch (err: any) {
        console.error('[3] suggestFix(): FAILED');
        console.error(`    ${err.message ?? err}`);
        process.exit(1);
    }

    // ── 4. Token usage summary ───────────────────────────────────────────────
    const usage = service.getTokenUsage();
    console.log('\n[4] Token Usage Summary');
    console.log(`    Prompt     : ${usage.promptTokens}`);
    console.log(`    Completion : ${usage.completionTokens}`);
    console.log(`    Total      : ${usage.totalTokens}`);

    console.log('\n' + '='.repeat(60));
    console.log('ALL TESTS PASSED');
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
