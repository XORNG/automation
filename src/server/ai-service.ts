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
  /** Max retry attempts for rate-limited or failed requests (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 5000) */
  retryDelayMs?: number;
  /** Maximum delay in ms between retries (default: 120000 = 2 minutes) */
  maxRetryDelayMs?: number;
  /** Fallback models to try if primary model fails (OpenRouter feature) */
  fallbackModels?: string[];
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
  private config: Required<Pick<AIServiceConfig, 'apiKey' | 'model' | 'baseUrl' | 'httpReferer' | 'siteName' | 'maxRetries' | 'retryDelayMs' | 'maxRetryDelayMs'>> & AIServiceConfig;
  private enabled: boolean;

  // OpenRouter API endpoint
  private static readonly DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
  
  // Default fallback models (FREE models on OpenRouter - no cost)
  // OpenRouter limits models array to 3 items max (1 primary + 2 fallbacks)
  private static readonly DEFAULT_FALLBACK_MODELS = [
    'xiaomi/mimo-v2-flash:free',          // MiMo-V2 MoE model, #1 on SWE-bench, 256K context
    'kwaipilot/kat-coder-pro:free',       // KAT-Coder-Pro, optimized for coding tasks
  ];

  constructor(config: AIServiceConfig) {
    super();
    this.config = {
      ...config,
      baseUrl: config.baseUrl || AIService.DEFAULT_BASE_URL,
      httpReferer: config.httpReferer || 'https://github.com/XORNG',
      siteName: config.siteName || 'XORNG Automation',
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 5000,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 120000,
      fallbackModels: config.fallbackModels ?? AIService.DEFAULT_FALLBACK_MODELS,
    };
    this.enabled = !!config.apiKey;
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'ai-service',
    });

    if (!this.enabled) {
      this.logger.warn('AI service is disabled - OPENROUTER_API_KEY not configured');
    } else {
      this.logger.info({ 
        model: config.model,
        fallbackModels: this.config.fallbackModels,
        maxRetries: this.config.maxRetries,
        retryDelayMs: this.config.retryDelayMs,
      }, 'AI service initialized with OpenRouter');
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
   * Calculate exponential backoff delay with jitter
   */
  private calculateRetryDelay(attempt: number, rateLimitResetMs?: number): number {
    // If we have a rate limit reset time from the API, use it (with some buffer)
    if (rateLimitResetMs && rateLimitResetMs > 0) {
      const waitTime = Math.min(rateLimitResetMs + 1000, this.config.maxRetryDelayMs);
      return waitTime;
    }
    
    // Exponential backoff: delay * 2^attempt with jitter
    const baseDelay = this.config.retryDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return Math.min(baseDelay + jitter, this.config.maxRetryDelayMs);
  }

  /**
   * Extract rate limit reset time from error response
   */
  private extractRateLimitReset(errorText: string, headers?: Headers): number | undefined {
    try {
      // Try to get from response headers first
      if (headers) {
        const resetHeader = headers.get('X-RateLimit-Reset');
        if (resetHeader) {
          const resetTime = parseInt(resetHeader, 10);
          if (!isNaN(resetTime)) {
            return resetTime - Date.now();
          }
        }
      }
      
      // Try to parse from error body
      const errorJson = JSON.parse(errorText);
      const resetHeader = errorJson?.error?.metadata?.headers?.['X-RateLimit-Reset'];
      if (resetHeader) {
        const resetTime = parseInt(resetHeader, 10);
        if (!isNaN(resetTime)) {
          return resetTime - Date.now();
        }
      }
    } catch {
      // Ignore parsing errors
    }
    return undefined;
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(status: number): boolean {
    // Retry on rate limits (429) and server errors (5xx)
    return status === 429 || (status >= 500 && status < 600);
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Make a chat completion request to OpenRouter with automatic retry and model fallback
   * 
   * OpenRouter supports a `models` array parameter for automatic failover when the
   * primary model fails (provider issues, rate limits, etc.). The first available
   * model in the array will be used.
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      model?: string;
      useFallbackModels?: boolean;
    }
  ): Promise<AICompletionResponse> {
    if (!this.enabled) {
      throw new Error('AI service is disabled - OPENROUTER_API_KEY not configured');
    }

    const primaryModel = options?.model || this.config.model;
    const useFallback = options?.useFallbackModels ?? true;
    const url = `${this.config.baseUrl}/chat/completions`;

    // Build models array for OpenRouter automatic failover
    // When models array is provided, OpenRouter tries each in order until one succeeds
    const modelsArray = useFallback && this.config.fallbackModels?.length
      ? [primaryModel, ...this.config.fallbackModels.filter(m => m !== primaryModel)]
      : undefined;

    this.logger.debug({ 
      primaryModel, 
      modelsArray: modelsArray || [primaryModel],
      messageCount: messages.length,
    }, 'Making chat completion request');

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Build request body - use 'models' array for fallback, or 'model' for single model
        const requestBody: Record<string, unknown> = {
          messages,
          max_tokens: options?.maxTokens || 4096,
          temperature: options?.temperature || 0.7,
          // Route setting to improve reliability - allows OpenRouter to route around degraded providers
          route: 'fallback',
        };

        if (modelsArray && modelsArray.length > 1) {
          requestBody.models = modelsArray;
        } else {
          requestBody.model = primaryModel;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'HTTP-Referer': this.config.httpReferer!,
            'X-Title': this.config.siteName!,
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          // Check if this is a retryable error
          if (this.isRetryableError(response.status) && attempt < this.config.maxRetries) {
            const rateLimitResetMs = this.extractRateLimitReset(errorText, response.headers);
            const delayMs = this.calculateRetryDelay(attempt, rateLimitResetMs);
            
            this.logger.warn({
              status: response.status,
              attempt: attempt + 1,
              maxRetries: this.config.maxRetries,
              retryInMs: delayMs,
              rateLimitResetMs,
            }, `Retryable API error, waiting ${Math.round(delayMs / 1000)}s before retry`);
            
            this.emit('retry', { 
              attempt: attempt + 1, 
              status: response.status, 
              delayMs,
              error: errorText,
            });
            
            await this.sleep(delayMs);
            continue;
          }
          
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

        // Log success, noting if fallback was used
        const usedFallback = modelsArray && data.model !== primaryModel;
        if (attempt > 0 || usedFallback) {
          this.logger.info({
            id: result.id,
            requestedModel: primaryModel,
            actualModel: result.model,
            usedFallback,
            tokens: result.usage.totalTokens,
            retriesNeeded: attempt,
          }, usedFallback 
            ? `Chat completion successful using fallback model ${result.model}` 
            : 'Chat completion successful after retries');
        } else {
          this.logger.debug({
            id: result.id,
            model: result.model,
            tokens: result.usage.totalTokens,
          }, 'Chat completion successful');
        }

        this.emit('completion', result);
        return result;
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a network error that we should retry
        if (attempt < this.config.maxRetries && 
            (error instanceof TypeError || // Network errors
             (error as Error).message?.includes('fetch'))) {
          const delayMs = this.calculateRetryDelay(attempt);
          
          this.logger.warn({
            error: (error as Error).message,
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            retryInMs: delayMs,
          }, `Network error, waiting ${Math.round(delayMs / 1000)}s before retry`);
          
          this.emit('retry', { 
            attempt: attempt + 1, 
            error: (error as Error).message, 
            delayMs,
          });
          
          await this.sleep(delayMs);
          continue;
        }
        
        this.logger.error({ error }, 'Chat completion failed');
        throw error;
      }
    }
    
    // Should not reach here, but just in case
    throw lastError || new Error('Chat completion failed after all retries');
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
 * 
 * Environment variables:
 * - OPENROUTER_API_KEY: API key for OpenRouter (required)
 * - OPENROUTER_MODEL: Primary model to use (default: anthropic/claude-sonnet-4)
 * - AI_FALLBACK_MODELS: Comma-separated list of fallback models (optional)
 * - AI_MAX_RETRIES: Maximum retry attempts (default: 3)
 * - AI_RETRY_DELAY_MS: Initial retry delay in ms (default: 5000)
 * - AI_MAX_RETRY_DELAY_MS: Maximum retry delay in ms (default: 120000)
 */
export function createAIServiceFromEnv(options?: { logLevel?: string }): AIService {
  // Parse fallback models from comma-separated string
  const fallbackModelsEnv = process.env.AI_FALLBACK_MODELS;
  const fallbackModels = fallbackModelsEnv
    ? fallbackModelsEnv.split(',').map(m => m.trim()).filter(m => m.length > 0)
    : undefined;

  return new AIService({
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'mistralai/devstral-2512:free',
    logLevel: options?.logLevel || process.env.LOG_LEVEL || 'info',
    maxRetries: process.env.AI_MAX_RETRIES ? parseInt(process.env.AI_MAX_RETRIES, 10) : undefined,
    retryDelayMs: process.env.AI_RETRY_DELAY_MS ? parseInt(process.env.AI_RETRY_DELAY_MS, 10) : undefined,
    maxRetryDelayMs: process.env.AI_MAX_RETRY_DELAY_MS ? parseInt(process.env.AI_MAX_RETRY_DELAY_MS, 10) : undefined,
    fallbackModels,
  });
}
