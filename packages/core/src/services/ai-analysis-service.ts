/**
 * AI Analysis Service
 * 
 * High-level service for AI-powered code analysis.
 * Provides "Explain Issue" and "Suggest Fix" functionality.
 */

import type { AIProvider, AIContext, SecurityIssue, SecurityFix } from '../ports';
import { createLogger } from '../utils/logger';

const logger = createLogger('AIAnalysisService');

/**
 * Prompt templates for different analysis types
 */
const PROMPTS = {
    explainIssue: `You are a security expert helping a developer understand a code issue.

Explain this security/code issue in a clear, educational way:

**Issue:** {{title}}
**Severity:** {{severity}}
**Description:** {{description}}
**File:** {{filePath}}
**Line:** {{line}}

{{#if snippet}}
**Code Snippet:**
\`\`\`
{{snippet}}
\`\`\`
{{/if}}

Please provide:
1. A clear explanation of what's wrong
2. Why this is a {{severity}} severity issue
3. What could happen if left unfixed (potential impact)
4. How to think about this type of issue in the future

Keep your response concise but educational. Use markdown formatting.`,

    suggestFix: `You are a security expert suggesting a fix for a code issue.

**Issue:** {{title}}
**Severity:** {{severity}}
**Description:** {{description}}
**File:** {{filePath}}
**Line:** {{line}}

{{#if snippet}}
**Problematic Code:**
\`\`\`{{language}}
{{snippet}}
\`\`\`
{{/if}}

Please provide a fix in the following JSON format:
\`\`\`json
{
  "description": "Brief description of what the fix does",
  "replacement": "The corrected code that should replace the problematic code",
  "autoFixable": true/false (whether this fix is safe to auto-apply)
}
\`\`\`

If you include the corrected code in "replacement", make sure it's complete and ready to use.
Only set autoFixable to true if the fix is straightforward and low-risk.`,
};

/**
 * Token usage tracking
 */
interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/**
 * AI Analysis Service
 * 
 * Provides high-level AI-powered analysis capabilities for security issues.
 */
export class AIAnalysisService {
    private aiProvider: AIProvider;
    private tokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    constructor(aiProvider: AIProvider) {
        this.aiProvider = aiProvider;
    }

    /**
     * Explain a security issue using AI
     */
    async explainIssue(issue: SecurityIssue, codeContext?: string): Promise<string> {
        logger.info('Explaining issue', { ruleId: issue.ruleId, severity: issue.severity });

        // Build the prompt using template
        const prompt = this.buildPrompt(PROMPTS.explainIssue, {
            title: issue.title,
            severity: issue.severity,
            description: issue.description,
            filePath: issue.filePath,
            line: issue.line.toString(),
            snippet: issue.snippet || codeContext || '',
        });

        const context: AIContext = {
            content: codeContext || issue.snippet || '',
            filePath: issue.filePath,
            language: this.detectLanguage(issue.filePath),
            systemPrompt: 'You are a helpful security expert explaining code issues to developers.',
        };

        try {
            const response = await this.aiProvider.complete(prompt, context);
            this.updateTokenUsage(response.usage);
            return response.content;
        } catch (error) {
            logger.error('Failed to explain issue', { error });
            throw error; // Re-throw the original error to preserve rich metadata
        }
    }

    /**
     * Stream an explanation for an issue (for real-time UI updates)
     */
    async *explainIssueStream(issue: SecurityIssue, codeContext?: string): AsyncIterable<string> {
        logger.info('Streaming issue explanation', { ruleId: issue.ruleId });

        const prompt = this.buildPrompt(PROMPTS.explainIssue, {
            title: issue.title,
            severity: issue.severity,
            description: issue.description,
            filePath: issue.filePath,
            line: issue.line.toString(),
            snippet: issue.snippet || codeContext || '',
        });

        const context: AIContext = {
            content: codeContext || issue.snippet || '',
            filePath: issue.filePath,
            language: this.detectLanguage(issue.filePath),
            systemPrompt: 'You are a helpful security expert explaining code issues to developers.',
        };

        try {
            for await (const chunk of this.aiProvider.stream(prompt, context)) {
                yield chunk;
            }
        } catch (error) {
            logger.error('Failed to stream explanation', { error });
            throw error;
        }
    }

    /**
     * Suggest a fix for a security issue
     */
    async suggestFix(issue: SecurityIssue, codeContext?: string): Promise<SecurityFix> {
        logger.info('Suggesting fix', { ruleId: issue.ruleId });

        const language = this.detectLanguage(issue.filePath);
        const prompt = this.buildPrompt(PROMPTS.suggestFix, {
            title: issue.title,
            severity: issue.severity,
            description: issue.description,
            filePath: issue.filePath,
            line: issue.line.toString(),
            snippet: issue.snippet || codeContext || '',
            language,
        });

        const context: AIContext = {
            content: codeContext || issue.snippet || '',
            filePath: issue.filePath,
            language,
            systemPrompt: 'You are a security expert providing code fixes. Return ONLY valid JSON.',
        };

        try {
            const response = await this.aiProvider.complete(prompt, context);
            this.updateTokenUsage(response.usage);

            // Parse the JSON response
            const fix = this.parseSuggestedFix(response.content, issue.snippet);
            return fix;
        } catch (error) {
            logger.error('Failed to suggest fix', { error });
            throw error; // Re-throw the original error to preserve rich metadata
        }
    }

    /**
     * Get accumulated token usage
     */
    getTokenUsage(): TokenUsage {
        return { ...this.tokenUsage };
    }

    /**
     * Reset token usage counter
     */
    resetTokenUsage(): void {
        this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }

    /**
     * Check if AI is available
     */
    async isAvailable(): Promise<boolean> {
        return this.aiProvider.isAvailable();
    }

    /**
     * Change the underlying AI provider
     */
    setProvider(provider: AIProvider): void {
        this.aiProvider = provider;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    /**
     * Build a prompt from a template with variable substitution
     */
    private buildPrompt(template: string, variables: Record<string, string>): string {
        let result = template;

        // Handle {{#if variable}}...{{/if}} conditionals
        result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
            return variables[varName] ? content : '';
        });

        // Replace {{variable}} placeholders
        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }

        return result;
    }

    /**
     * Parse a suggested fix from AI response
     */
    private parseSuggestedFix(response: string, original?: string): SecurityFix {
        const tryParse = (text: string): SecurityFix | null => {
            try {
                const parsed = JSON.parse(text);
                const fix: SecurityFix = {
                    description: parsed.description || 'AI-suggested fix',
                    replacement: parsed.replacement || '',
                    autoFixable: parsed.autoFixable === true,
                };
                if (original !== undefined) {
                    fix.original = original;
                }
                return fix;
            } catch {
                return null;
            }
        };

        let parsed: SecurityFix | null = null;

        // 1. Try extracting JSON from a ```json...``` block
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch?.[1]) {
            parsed = tryParse(jsonMatch[1]);
            if (parsed) return parsed;
        }

        // 2. Try extracting from any ```...``` block
        const codeBlockMatch = response.match(/```[\w]*\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch?.[1]) {
            parsed = tryParse(codeBlockMatch[1]);
            if (parsed) return parsed;
        }

        // 3. Try parsing the full response as raw JSON
        parsed = tryParse(response.trim());
        if (parsed) return parsed;

        // 4. Try extracting code blocks as text replacement
        const extractedCode = codeBlockMatch?.[1]?.trim() || '';

        const fallbackFix: SecurityFix = {
            description: extractedCode
                ? 'AI suggested the following fix (requires manual review)'
                : 'AI could not generate a structured fix. Please review the response manually.',
            replacement: extractedCode || '',
            autoFixable: false,
        };
        if (original !== undefined) {
            fallbackFix.original = original;
        }

        if (!extractedCode) {
            logger.debug('Raw AI response (no structured fix found)', { response: response.slice(0, 500) });
        }

        return fallbackFix;
    }

    /**
     * Detect programming language from file path
     */
    private detectLanguage(filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const languageMap: Record<string, string> = {
            ts: 'typescript',
            tsx: 'typescript',
            js: 'javascript',
            jsx: 'javascript',
            py: 'python',
            rb: 'ruby',
            go: 'go',
            rs: 'rust',
            java: 'java',
            kt: 'kotlin',
            swift: 'swift',
            c: 'c',
            cpp: 'cpp',
            cs: 'csharp',
            php: 'php',
        };
        return languageMap[ext] || ext;
    }

    /**
     * Update accumulated token usage
     */
    private updateTokenUsage(usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
        if (usage) {
            this.tokenUsage.promptTokens += usage.promptTokens;
            this.tokenUsage.completionTokens += usage.completionTokens;
            this.tokenUsage.totalTokens += usage.totalTokens;
        }
    }
}

/**
 * Factory function to create an AI Analysis Service
 */
export function createAIAnalysisService(aiProvider: AIProvider): AIAnalysisService {
    return new AIAnalysisService(aiProvider);
}
