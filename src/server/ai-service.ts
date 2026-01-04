import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';

/**
 * OpenRouter API configuration
 * 
 * TEMPORARY SOLUTION: API key is passed via environment variables from GitHub Secrets.
 * This approach is suitable for testing and initial deployment but should be replaced
 * with a more robust secrets management solution (e.g., HashiCorp Vault, AWS Secrets Manager)
 * in production environments.
 */
export interface AIServiceConfig {
  apiKey: string;
  model: string;
  logLevel?: string;
  /** Base URL for OpenRouter API (default: https://openrouter.ai/api/v1) */
  baseUrl?: string;
  /** HTTP Referer header for OpenRouter (optional, for ranking) */
  httpReferer?: string;
  /** Site name for OpenRouter (optional, for ranking) */
  siteName?: string;
}

/**
 * Message format for chat completions
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Response from AI completion
 */
export interface AICompletionResponse {
  id: string;
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

/**
 * Code change suggestion from AI
 */
export interface CodeChangeSuggestion {
  file: string;
  description: string;
  originalCode?: string;
  suggestedCode: string;
  lineStart?: number;
  lineEnd?: number;
  confidence: number;
}

/**
 * PR review result from AI
 */
export interface PRReviewResult {
  summary: string;
  approved: boolean;
  suggestions: CodeChangeSuggestion[];
  concerns: string[];
  mergeRecommendation: 'merge' | 'request-changes' | 'needs-discussion';
}

/**
 * Issue analysis result from AI
 */
export interface IssueAnalysisResult {
  summary: string;
  category: 'bug' | 'feature' | 'enhancement' | 'documentation' | 'question' | 'other';
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedLabels: string[];
  implementationSuggestions: CodeChangeSuggestion[];
  estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex';
}

/**
 * AIService - Handles AI-powered code analysis and generation via OpenRouter
 * 
 * Features:
 * - OpenRouter API integration for multi-model support
 * - PR review and analysis
 * - Issue analysis and code suggestions
 * - Code change generation based on feedback
 * 
 * TEMPORARY SOLUTION: Uses environment variables for API key.
 * Should be migrated to proper secrets management in production.
 */
export class AIService extends EventEmitter {
  private logger: Logger;
  private config: AIServiceConfig;
  private enabled: boolean;

  // OpenRouter API endpoint
  private static readonly DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

  constructor(config: AIServiceConfig) {
    super();
    this.config = {
      ...config,
      baseUrl: config.baseUrl || AIService.DEFAULT_BASE_URL,
      httpReferer: config.httpReferer || 'https://github.com/XORNG',
      siteName: config.siteName || 'XORNG Automation',
    };
    this.enabled = !!config.apiKey;
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'ai-service',
    });

    if (!this.enabled) {
      this.logger.warn('AI service is disabled - OPENROUTER_API_KEY not configured');
    } else {
      this.logger.info({ model: config.model }, 'AI service initialized with OpenRouter');
    }
  }

  /**
   * Check if AI service is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get the configured model
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Make a chat completion request to OpenRouter
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      model?: string;
    }
  ): Promise<AICompletionResponse> {
    if (!this.enabled) {
      throw new Error('AI service is disabled - OPENROUTER_API_KEY not configured');
    }

    const model = options?.model || this.config.model;
    const url = `${this.config.baseUrl}/chat/completions`;

    this.logger.debug({ model, messageCount: messages.length }, 'Making chat completion request');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'HTTP-Referer': this.config.httpReferer!,
          'X-Title': this.config.siteName!,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options?.maxTokens || 4096,
          temperature: options?.temperature || 0.7,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error({ status: response.status, error: errorText }, 'OpenRouter API error');
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        id: string;
        model: string;
        choices: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const result: AICompletionResponse = {
        id: data.id,
        content: data.choices[0]?.message?.content || '',
        model: data.model,
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
        finishReason: data.choices[0]?.finish_reason || 'unknown',
      };

      this.logger.debug({
        id: result.id,
        model: result.model,
        tokens: result.usage.totalTokens,
      }, 'Chat completion successful');

      this.emit('completion', result);
      return result;
    } catch (error) {
      this.logger.error({ error }, 'Chat completion failed');
      throw error;
    }
  }

  /**
   * Analyze a GitHub issue and provide implementation suggestions
   */
  async analyzeIssue(issue: {
    title: string;
    body: string | null;
    labels: string[];
    repository: string;
  }): Promise<IssueAnalysisResult> {
    if (!this.enabled) {
      throw new Error('AI service is disabled');
    }

    const systemPrompt = `You are an expert software engineer analyzing a GitHub issue. 
Analyze the issue and provide:
1. A brief summary
2. Category (bug, feature, enhancement, documentation, question, or other)
3. Priority level (low, medium, high, critical)
4. Suggested labels
5. Implementation suggestions with code changes if applicable
6. Estimated complexity

Respond in JSON format with the following structure:
{
  "summary": "string",
  "category": "bug|feature|enhancement|documentation|question|other",
  "priority": "low|medium|high|critical",
  "suggestedLabels": ["string"],
  "implementationSuggestions": [
    {
      "file": "string",
      "description": "string",
      "suggestedCode": "string",
      "confidence": 0.0-1.0
    }
  ],
  "estimatedComplexity": "trivial|simple|moderate|complex"
}`;

    const userPrompt = `Repository: ${issue.repository}
Title: ${issue.title}
Labels: ${issue.labels.join(', ') || 'none'}

Body:
${issue.body || 'No description provided'}`;

    const response = await this.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.3 });

    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response.content;
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      const result = JSON.parse(jsonStr.trim()) as IssueAnalysisResult;
      this.emit('issue:analyzed', { issue, result });
      return result;
    } catch (error) {
      this.logger.error({ error, content: response.content }, 'Failed to parse issue analysis response');
      throw new Error('Failed to parse AI response for issue analysis');
    }
  }

  /**
   * Review a pull request and provide feedback
   */
  async reviewPullRequest(pr: {
    title: string;
    body: string | null;
    repository: string;
    baseBranch: string;
    headBranch: string;
    diff: string;
    changedFiles: Array<{ filename: string; patch?: string }>;
  }): Promise<PRReviewResult> {
    if (!this.enabled) {
      throw new Error('AI service is disabled');
    }

    const systemPrompt = `You are an expert code reviewer analyzing a GitHub pull request.
Review the changes and provide:
1. A summary of the changes
2. Whether you approve or not
3. Specific suggestions for improvements with code changes
4. Any security, performance, or maintainability concerns
5. Your merge recommendation

Respond in JSON format with the following structure:
{
  "summary": "string",
  "approved": boolean,
  "suggestions": [
    {
      "file": "string",
      "description": "string",
      "originalCode": "string (optional)",
      "suggestedCode": "string",
      "lineStart": number (optional),
      "lineEnd": number (optional),
      "confidence": 0.0-1.0
    }
  ],
  "concerns": ["string"],
  "mergeRecommendation": "merge|request-changes|needs-discussion"
}`;

    // Truncate diff if too long (OpenRouter has token limits)
    const maxDiffLength = 10000;
    let diffContent = pr.diff;
    if (diffContent.length > maxDiffLength) {
      diffContent = diffContent.substring(0, maxDiffLength) + '\n\n... [diff truncated]';
    }

    const userPrompt = `Repository: ${pr.repository}
PR Title: ${pr.title}
Base Branch: ${pr.baseBranch}
Head Branch: ${pr.headBranch}

Description:
${pr.body || 'No description provided'}

Changed Files: ${pr.changedFiles.map(f => f.filename).join(', ')}

Diff:
\`\`\`
${diffContent}
\`\`\``;

    const response = await this.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.3, maxTokens: 4096 });

    try {
      // Extract JSON from response
      let jsonStr = response.content;
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      const result = JSON.parse(jsonStr.trim()) as PRReviewResult;
      this.emit('pr:reviewed', { pr, result });
      return result;
    } catch (error) {
      this.logger.error({ error, content: response.content }, 'Failed to parse PR review response');
      throw new Error('Failed to parse AI response for PR review');
    }
  }

  /**
   * Generate code changes based on feedback or issue
   */
  async generateCodeChanges(request: {
    context: string;
    requirement: string;
    existingCode?: string;
    language: string;
    repository: string;
  }): Promise<CodeChangeSuggestion[]> {
    if (!this.enabled) {
      throw new Error('AI service is disabled');
    }

    const systemPrompt = `You are an expert programmer generating code changes.
Based on the context and requirements, generate specific code changes.

Respond in JSON format with an array of changes:
[
  {
    "file": "path/to/file",
    "description": "what this change does",
    "originalCode": "code to replace (if modifying existing)",
    "suggestedCode": "new code",
    "lineStart": number (optional),
    "lineEnd": number (optional),
    "confidence": 0.0-1.0
  }
]

Focus on:
- Clean, maintainable code
- Following best practices for ${request.language}
- Minimal changes to achieve the requirement
- Proper error handling`;

    const userPrompt = `Repository: ${request.repository}
Language: ${request.language}

Context:
${request.context}

Requirement:
${request.requirement}

${request.existingCode ? `Existing Code:\n\`\`\`${request.language}\n${request.existingCode}\n\`\`\`` : ''}`;

    const response = await this.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.5 });

    try {
      // Extract JSON from response
      let jsonStr = response.content;
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      const result = JSON.parse(jsonStr.trim()) as CodeChangeSuggestion[];
      this.emit('code:generated', { request, result });
      return result;
    } catch (error) {
      this.logger.error({ error, content: response.content }, 'Failed to parse code generation response');
      throw new Error('Failed to parse AI response for code generation');
    }
  }

  /**
   * Get AI service status
   */
  getStatus(): {
    enabled: boolean;
    model: string;
    baseUrl: string;
  } {
    return {
      enabled: this.enabled,
      model: this.config.model,
      baseUrl: this.config.baseUrl!,
    };
  }
}

/**
 * Create an AI service instance from environment variables
 */
export function createAIServiceFromEnv(options?: { logLevel?: string }): AIService {
  return new AIService({
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4',
    logLevel: options?.logLevel || process.env.LOG_LEVEL || 'info',
  });
}
