import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';
import { AIService, type CodeChangeSuggestion } from './ai-service.js';

/**
 * Learning service interface - matches @xorng/core LearningService API
 * Kept inline to avoid circular dependency issues
 */
export interface LearningServiceInterface {
  recordFixAttempt(attempt: {
    repo: string;
    prNumber: number;
    failureType: string;
    errorPattern: string;
    attemptNumber: number;
    successful: boolean;
    patternUsed?: string;
    knowledgeUsed?: boolean;
    validatorPassed?: boolean;
    appliedFixes?: Array<{ file: string; description: string }>;
    error?: string;
  }): Promise<void>;
  
  findSimilarPatterns(failureType: string, errorPattern: string, limit?: number): Promise<FixPatternInterface[]>;
  
  getMetrics(): SelfImprovementMetricsInterface;
  
  recordKnowledgeAgentHit(): void;
  
  recordValidatorResult(passed: boolean): void;
}

/**
 * Fix pattern interface from learning service
 */
export interface FixPatternInterface {
  id: string;
  failureType: 'lint' | 'typecheck' | 'test' | 'build' | 'security' | 'format' | 'other';
  errorPattern: string;
  appliedFix: Array<{
    file: string;
    description: string;
    changeType: 'modify' | 'create' | 'delete';
  }>;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsed: Date;
  createdAt: Date;
}

/**
 * Self-improvement metrics interface
 */
export interface SelfImprovementMetricsInterface {
  fixSuccessRateByType: Record<string, { success: number; failure: number; rate: number }>;
  averageAttemptsToFix: number;
  learningVelocity: number;
  patternHitRate: number;
  totalPatternsLearned: number;
  knowledgeAgentHits: number;
  validatorPreCheckResults: { passed: number; failed: number };
}

/**
 * Check run status and details
 */
export interface CheckRunData {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
    annotations?: Array<{
      path: string;
      startLine: number;
      endLine: number;
      annotationLevel: 'notice' | 'warning' | 'failure';
      message: string;
      rawDetails?: string;
    }>;
  };
}

/**
 * Workflow run data
 */
export interface WorkflowRunData {
  id: number;
  name: string;
  headBranch: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  htmlUrl: string;
  runNumber: number;
  event: string;
  pullRequests: Array<{
    number: number;
    url: string;
  }>;
}

/**
 * Pipeline failure analysis result
 */
export interface PipelineFailureAnalysis {
  checkRunId: number;
  checkRunName: string;
  failureType: 'lint' | 'typecheck' | 'test' | 'build' | 'security' | 'format' | 'other';
  errorMessages: string[];
  affectedFiles: string[];
  suggestedFixes: CodeChangeSuggestion[];
  autoFixable: boolean;
  confidence: number;
}

/**
 * Pipeline status summary for a PR
 */
export interface PRPipelineStatus {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  pendingChecks: number;
  allPassed: boolean;
  failures: CheckRunData[];
  analysis?: PipelineFailureAnalysis[];
}

/**
 * Pipeline fix result
 */
export interface PipelineFixResult {
  success: boolean;
  fixedIssues: number;
  totalIssues: number;
  appliedFixes: Array<{
    file: string;
    description: string;
    changeType: 'modify' | 'create' | 'delete';
  }>;
  commitSha?: string;
  error?: string;
}

/**
 * Knowledge query result from knowledge agents
 */
export interface KnowledgeQueryResult {
  practices: Array<{
    title: string;
    description: string;
    category: string;
    severity: string;
    examples?: string[];
  }>;
  source: string;
}

/**
 * Knowledge query callback type
 */
export type KnowledgeQueryFn = (
  failureType: string,
  language: string,
  context: string
) => Promise<KnowledgeQueryResult | null>;

/**
 * Validator callback type
 */
export type ValidatorCheckFn = (
  fixes: CodeChangeSuggestion[],
  context: { owner: string; repo: string; prNumber: number }
) => Promise<{ passed: boolean; issues: string[] }>;

/**
 * Configuration for Pipeline Monitor
 */
export interface PipelineMonitorConfig {
  token: string;
  organization: string;
  logLevel?: string;
  aiService?: AIService;
  /** Learning service for self-improvement (from @xorng/core) */
  learningService?: LearningServiceInterface;
  /** Callback to query knowledge agents for best practices */
  queryKnowledge?: KnowledgeQueryFn;
  /** Callback to run validator pre-checks on generated fixes */
  validateFixes?: ValidatorCheckFn;
  /** Max retry attempts for fixing pipeline failures */
  maxFixAttempts?: number;
  /** Enable auto-fix functionality */
  autoFixEnabled?: boolean;
  /** Required passing checks before merge */
  requiredChecks?: string[];
}

/**
 * PipelineMonitor - Monitors CI/CD pipeline status and enables self-healing
 * 
 * Features:
 * - Monitors check runs and workflow runs for PRs
 * - Detects pipeline failures and analyzes root causes
 * - Uses AI to generate fixes for common failure types
 * - Applies fixes automatically when confident
 * - Posts human-in-the-loop approval request when ready to merge
 * 
 * Self-Improvement Guidelines:
 * - Learn from successful and failed fix attempts
 * - Track patterns in pipeline failures
 * - Improve fix suggestions based on feedback
 */
export class PipelineMonitor extends EventEmitter {
  private octokit: Octokit;
  private logger: Logger;
  private config: PipelineMonitorConfig;
  private aiService?: AIService;
  private learningService?: LearningServiceInterface;
  
  // Track fix attempts per PR to prevent infinite loops
  private fixAttempts: Map<string, number> = new Map();

  constructor(config: PipelineMonitorConfig) {
    super();
    this.config = {
      maxFixAttempts: config.maxFixAttempts || 3,
      autoFixEnabled: config.autoFixEnabled ?? true,
      ...config,
    };
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.aiService = config.aiService;
    this.learningService = config.learningService;
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'pipeline-monitor',
    });

    this.logger.info({
      autoFixEnabled: this.config.autoFixEnabled,
      maxFixAttempts: this.config.maxFixAttempts,
      learningServiceEnabled: !!this.learningService,
    }, 'Pipeline monitor initialized');
  }

  /**
   * Set or update AI service
   */
  setAIService(aiService: AIService): void {
    this.aiService = aiService;
    this.logger.info({ enabled: aiService.isEnabled() }, 'AI service configured for pipeline monitor');
  }

  /**
   * Set or update learning service for self-improvement
   */
  setLearningService(learningService: LearningServiceInterface): void {
    this.learningService = learningService;
    this.logger.info('Learning service configured for pipeline monitor');
  }

  /**
   * Get self-improvement metrics from learning service
   */
  async getSelfImprovementMetrics(): Promise<SelfImprovementMetricsInterface | null> {
    if (!this.learningService) {
      return null;
    }
    return this.learningService.getMetrics();
  }

  /**
   * Get the status of all check runs for a PR
   */
  async getPRPipelineStatus(owner: string, repo: string, prNumber: number): Promise<PRPipelineStatus | null> {
    try {
      // Get PR details to get the head SHA
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      const headSha = pr.head.sha;

      // Get all check runs for this commit
      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: headSha,
      });

      const checks = checkRuns.check_runs.map(run => ({
        id: run.id,
        name: run.name,
        status: run.status as CheckRunData['status'],
        conclusion: run.conclusion as CheckRunData['conclusion'],
        startedAt: run.started_at,
        completedAt: run.completed_at,
        htmlUrl: run.html_url || '',
        output: {
          title: run.output?.title || null,
          summary: run.output?.summary || null,
          text: run.output?.text || null,
          annotations: [],
        },
      }));

      const passedChecks = checks.filter(c => c.conclusion === 'success' || c.conclusion === 'skipped');
      const failedChecks = checks.filter(c => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'action_required');
      const pendingChecks = checks.filter(c => c.status !== 'completed');

      return {
        owner,
        repo,
        prNumber,
        headSha,
        totalChecks: checks.length,
        passedChecks: passedChecks.length,
        failedChecks: failedChecks.length,
        pendingChecks: pendingChecks.length,
        allPassed: failedChecks.length === 0 && pendingChecks.length === 0 && checks.length > 0,
        failures: failedChecks,
      };
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to get PR pipeline status');
      return null;
    }
  }

  /**
   * Get detailed check run information including annotations
   */
  async getCheckRunDetails(owner: string, repo: string, checkRunId: number): Promise<CheckRunData | null> {
    try {
      const { data: run } = await this.octokit.checks.get({
        owner,
        repo,
        check_run_id: checkRunId,
      });

      // Get annotations separately
      const { data: annotations } = await this.octokit.checks.listAnnotations({
        owner,
        repo,
        check_run_id: checkRunId,
      });

      return {
        id: run.id,
        name: run.name,
        status: run.status as CheckRunData['status'],
        conclusion: run.conclusion as CheckRunData['conclusion'],
        startedAt: run.started_at,
        completedAt: run.completed_at,
        htmlUrl: run.html_url || '',
        output: {
          title: run.output?.title || null,
          summary: run.output?.summary || null,
          text: run.output?.text || null,
          annotations: annotations.map(a => ({
            path: a.path,
            startLine: a.start_line,
            endLine: a.end_line,
            annotationLevel: a.annotation_level as 'notice' | 'warning' | 'failure',
            message: a.message || '',
            rawDetails: a.raw_details || undefined,
          })),
        },
      };
    } catch (error) {
      this.logger.error({ error, owner, repo, checkRunId }, 'Failed to get check run details');
      return null;
    }
  }

  /**
   * Get workflow run logs for detailed failure analysis
   */
  async getWorkflowRunLogs(owner: string, repo: string, runId: number): Promise<string | null> {
    try {
      const { data: logs } = await this.octokit.actions.downloadWorkflowRunLogs({
        owner,
        repo,
        run_id: runId,
      });

      // The logs come as a zip file, we'd need to extract them
      // For now, we'll use the jobs endpoint to get individual job logs
      return String(logs);
    } catch (error) {
      this.logger.error({ error, owner, repo, runId }, 'Failed to get workflow run logs');
      return null;
    }
  }

  /**
   * Get failed jobs from a workflow run
   */
  async getFailedJobs(owner: string, repo: string, runId: number): Promise<Array<{
    name: string;
    conclusion: string;
    steps: Array<{
      name: string;
      conclusion: string;
      number: number;
    }>;
  }> | null> {
    try {
      const { data: jobs } = await this.octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
        filter: 'latest',
      });

      return jobs.jobs
        .filter(job => job.conclusion === 'failure')
        .map(job => ({
          name: job.name,
          conclusion: job.conclusion || 'unknown',
          steps: (job.steps || []).map(step => ({
            name: step.name,
            conclusion: step.conclusion || 'unknown',
            number: step.number,
          })),
        }));
    } catch (error) {
      this.logger.error({ error, owner, repo, runId }, 'Failed to get failed jobs');
      return null;
    }
  }

  /**
   * Analyze pipeline failures using AI
   */
  async analyzeFailures(status: PRPipelineStatus): Promise<PipelineFailureAnalysis[]> {
    if (!this.aiService?.isEnabled()) {
      this.logger.warn('AI service not enabled, skipping failure analysis');
      return [];
    }

    const analyses: PipelineFailureAnalysis[] = [];

    for (const failure of status.failures) {
      // Get detailed check run info with annotations
      const details = await this.getCheckRunDetails(status.owner, status.repo, failure.id);
      if (!details) continue;

      // Determine failure type from check name
      const failureType = this.determineFailureType(failure.name);

      // Collect error messages
      const errorMessages: string[] = [];
      if (details.output.summary) {
        errorMessages.push(details.output.summary);
      }
      if (details.output.annotations) {
        for (const annotation of details.output.annotations) {
          if (annotation.annotationLevel === 'failure' || annotation.annotationLevel === 'warning') {
            errorMessages.push(`${annotation.path}:${annotation.startLine} - ${annotation.message}`);
          }
        }
      }

      // Get affected files from annotations
      const affectedFiles = details.output.annotations
        ? [...new Set(details.output.annotations.map(a => a.path))]
        : [];

      // Use AI to analyze and suggest fixes
      const aiAnalysis = await this.analyzeFailureWithAI({
        checkName: failure.name,
        failureType,
        errorMessages,
        affectedFiles,
        outputText: details.output.text || '',
      });

      analyses.push({
        checkRunId: failure.id,
        checkRunName: failure.name,
        failureType,
        errorMessages,
        affectedFiles,
        suggestedFixes: aiAnalysis?.fixes || [],
        autoFixable: aiAnalysis?.autoFixable || false,
        confidence: aiAnalysis?.confidence || 0,
      });
    }

    return analyses;
  }

  /**
   * Determine failure type from check name
   */
  private determineFailureType(checkName: string): PipelineFailureAnalysis['failureType'] {
    const nameLower = checkName.toLowerCase();
    
    if (nameLower.includes('lint') || nameLower.includes('eslint')) {
      return 'lint';
    }
    if (nameLower.includes('type') || nameLower.includes('typecheck') || nameLower.includes('tsc')) {
      return 'typecheck';
    }
    if (nameLower.includes('test') || nameLower.includes('jest') || nameLower.includes('vitest')) {
      return 'test';
    }
    if (nameLower.includes('build') || nameLower.includes('compile')) {
      return 'build';
    }
    if (nameLower.includes('security') || nameLower.includes('audit') || nameLower.includes('snyk')) {
      return 'security';
    }
    if (nameLower.includes('format') || nameLower.includes('prettier')) {
      return 'format';
    }
    
    return 'other';
  }

  /**
   * Analyze a failure using AI service, enhanced with learned patterns and knowledge
   */
  private async analyzeFailureWithAI(data: {
    checkName: string;
    failureType: PipelineFailureAnalysis['failureType'];
    errorMessages: string[];
    affectedFiles: string[];
    outputText: string;
    owner?: string;
    repo?: string;
  }): Promise<{
    fixes: CodeChangeSuggestion[];
    autoFixable: boolean;
    confidence: number;
    usedPatterns?: FixPatternInterface[];
  } | null> {
    if (!this.aiService?.isEnabled()) {
      return null;
    }

    try {
      // Build the error pattern from messages for learning service lookup
      const errorPattern = data.errorMessages.slice(0, 5).join('\n');
      
      // Get relevant learned patterns from learning service
      let learnedPatternsContext = '';
      let usedPatterns: FixPatternInterface[] = [];
      
      if (this.learningService) {
        usedPatterns = await this.learningService.findSimilarPatterns(
          data.failureType,
          errorPattern,
          5 // Get top 5 relevant patterns
        );
        
        if (usedPatterns.length > 0) {
          // Build enhanced context with learned patterns
          learnedPatternsContext = this.buildLearnedPatternsPrompt(usedPatterns);
          this.logger.info({
            failureType: data.failureType,
            patternsFound: usedPatterns.length,
            avgConfidence: usedPatterns.reduce((sum, p) => sum + p.confidence, 0) / usedPatterns.length,
          }, 'Found relevant learned patterns for AI analysis');
        }
      }

      // Query knowledge agents for best practices
      let knowledgeContext = '';
      if (this.config.queryKnowledge) {
        try {
          // Detect language from affected files
          const language = this.detectLanguageFromFiles(data.affectedFiles);
          
          const knowledgeResult = await this.config.queryKnowledge(
            data.failureType,
            language,
            errorPattern
          );
          
          if (knowledgeResult && knowledgeResult.practices.length > 0) {
            knowledgeContext = this.buildKnowledgeContextPrompt(knowledgeResult);
            this.logger.info({
              failureType: data.failureType,
              practicesFound: knowledgeResult.practices.length,
              source: knowledgeResult.source,
            }, 'Found relevant best practices from knowledge agents');
            
            // Track knowledge agent usage
            if (this.learningService) {
              this.learningService.recordKnowledgeAgentHit();
            }
          }
        } catch (error) {
          this.logger.warn({ error }, 'Failed to query knowledge agents');
        }
      }

      const prompt = this.buildFailureAnalysisPrompt(data);
      
      const systemPrompt = `You are an expert CI/CD pipeline debugger. Analyze pipeline failures and suggest specific, actionable fixes.

CRITICAL RULES:
1. ONLY suggest fixes for files that are EXPLICITLY mentioned in the error messages or affected files list
2. Do NOT suggest fixing files that don't exist or weren't mentioned in the error output
3. If the error is about a missing file or workflow, set autoFixable to false
4. For Dependabot PRs (dependency updates), most fixes should be marked as NOT auto-fixable

Your response must be valid JSON with this structure:
{
  "fixes": [
    {
      "file": "path/to/file.ts",
      "description": "Description of the fix",
      "suggestedCode": "The actual code fix",
      "originalCode": "The code to replace (if modifying existing code)",
      "lineStart": 10,
      "lineEnd": 15,
      "confidence": 0.9
    }
  ],
  "autoFixable": true,
  "confidence": 0.85,
  "explanation": "Brief explanation of the fix"
}

For common issues:
- Lint errors: Provide the corrected code with proper formatting
- Type errors: Provide proper type annotations or type guards
- Test failures: Explain what needs to change (usually not auto-fixable)
- Format errors: These are always auto-fixable with formatter
- Build errors: Provide specific code fixes
- Missing workflow files: NOT auto-fixable - requires manual intervention
- License/compliance issues: Usually NOT auto-fixable

Be conservative with autoFixable - only true if:
1. You're confident the fix won't break anything
2. The file exists and was mentioned in the error output
3. The fix is straightforward and well-understood

${knowledgeContext}${learnedPatternsContext}`;
      
      const response = await this.aiService.chatCompletion([
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ], {
        maxTokens: 2000,
        temperature: 0.3,
      });

      // Parse the response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn({ checkName: data.checkName }, 'AI response did not contain valid JSON');
        return null;
      }

      const result = JSON.parse(jsonMatch[0]);
      return {
        fixes: result.fixes || [],
        autoFixable: result.autoFixable || false,
        confidence: result.confidence || 0,
        usedPatterns,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to analyze failure with AI');
      return null;
    }
  }

  /**
   * Detect programming language from file extensions
   */
  private detectLanguageFromFiles(files: string[]): string {
    const extCounts: Record<string, number> = {};
    
    for (const file of files) {
      const ext = file.split('.').pop()?.toLowerCase() || '';
      const lang = this.extToLanguage(ext);
      if (lang) {
        extCounts[lang] = (extCounts[lang] || 0) + 1;
      }
    }
    
    // Return most common language or 'general'
    const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || 'general';
  }

  /**
   * Map file extension to language
   */
  private extToLanguage(ext: string): string | null {
    const mapping: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      kt: 'kotlin',
      rb: 'ruby',
      cs: 'csharp',
      cpp: 'cpp',
      c: 'c',
      swift: 'swift',
    };
    return mapping[ext] || null;
  }

  /**
   * Build prompt context from knowledge query results
   */
  private buildKnowledgeContextPrompt(result: KnowledgeQueryResult): string {
    if (result.practices.length === 0) {
      return '';
    }

    const practiceDescriptions = result.practices.slice(0, 3).map((p, i) => 
      `${i + 1}. **${p.title}** (${p.category}, ${p.severity}):\n` +
      `   ${p.description}` +
      (p.examples?.length ? `\n   Example: ${p.examples[0].slice(0, 200)}` : '')
    ).join('\n\n');

    return `
RELEVANT BEST PRACTICES from knowledge base (${result.source}):
Apply these guidelines when generating fixes:

${practiceDescriptions}

`;
  }

  /**
   * Build prompt context from learned patterns
   */
  private buildLearnedPatternsPrompt(patterns: FixPatternInterface[]): string {
    if (patterns.length === 0) {
      return '';
    }

    const patternDescriptions = patterns.map((p, i) => 
      `${i + 1}. Previous fix for similar "${p.failureType}" error (${Math.round(p.confidence * 100)}% confidence):\n` +
      `   Error signature: ${p.errorPattern.slice(0, 150)}...\n` +
      `   Applied fixes: ${p.appliedFix.map((f: { file: string; description: string }) => `${f.file}: ${f.description}`).join('; ')}\n` +
      `   Success rate: ${p.successCount}/${p.successCount + p.failureCount}`
    ).join('\n\n');

    return `
IMPORTANT: The following patterns were learned from PREVIOUS SUCCESSFUL fixes for similar issues.
Consider these when generating your fix - they have worked before:

${patternDescriptions}

Use these patterns as guidance but adapt to the specific error context.`;
  }

  /**
   * Build a prompt for failure analysis
   */
  private buildFailureAnalysisPrompt(data: {
    checkName: string;
    failureType: PipelineFailureAnalysis['failureType'];
    errorMessages: string[];
    affectedFiles: string[];
    outputText: string;
  }): string {
    return `Analyze this CI/CD pipeline failure and suggest fixes:

**Check Name:** ${data.checkName}
**Failure Type:** ${data.failureType}

**Error Messages:**
${data.errorMessages.map(m => `- ${m}`).join('\n')}

**Affected Files:**
${data.affectedFiles.map(f => `- ${f}`).join('\n') || 'Unknown'}

**Full Output:**
\`\`\`
${data.outputText.slice(0, 3000)}
\`\`\`

Please analyze this failure and provide specific fixes. Be precise about file paths and line numbers when suggesting code changes.`;
  }

  /**
   * Process a check_run webhook event
   */
  async processCheckRunEvent(payload: {
    action: string;
    check_run: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      pull_requests: Array<{ number: number }>;
    };
    repository: { name: string; owner: { login: string } };
  }): Promise<void> {
    const { action, check_run, repository } = payload;
    
    this.logger.info({
      action,
      checkRunName: check_run.name,
      status: check_run.status,
      conclusion: check_run.conclusion,
      prs: check_run.pull_requests.map(pr => pr.number),
    }, 'Processing check_run event');

    // Only process completed check runs with failures
    if (action !== 'completed' || check_run.conclusion !== 'failure') {
      return;
    }

    // Process each associated PR
    for (const pr of check_run.pull_requests) {
      await this.handlePRPipelineFailure(
        repository.owner.login,
        repository.name,
        pr.number
      );
    }
  }

  /**
   * Process a workflow_run webhook event
   */
  async processWorkflowRunEvent(payload: {
    action: string;
    workflow_run: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_sha: string;
      pull_requests: Array<{ number: number }>;
    };
    repository: { name: string; owner: { login: string } };
  }): Promise<void> {
    const { action, workflow_run, repository } = payload;
    
    this.logger.info({
      action,
      workflowName: workflow_run.name,
      status: workflow_run.status,
      conclusion: workflow_run.conclusion,
      prs: workflow_run.pull_requests.map(pr => pr.number),
    }, 'Processing workflow_run event');

    // Handle completed workflow runs
    if (action === 'completed') {
      for (const pr of workflow_run.pull_requests) {
        if (workflow_run.conclusion === 'failure') {
          await this.handlePRPipelineFailure(
            repository.owner.login,
            repository.name,
            pr.number
          );
        } else if (workflow_run.conclusion === 'success') {
          // Check if all checks are now passing
          await this.handlePRPipelineSuccess(
            repository.owner.login,
            repository.name,
            pr.number
          );
        }
      }
    }
  }

  /**
   * Handle PR pipeline failure - analyze and attempt to fix
   */
  async handlePRPipelineFailure(owner: string, repo: string, prNumber: number): Promise<void> {
    const prKey = `${owner}/${repo}#${prNumber}`;
    
    // Check fix attempts
    const attempts = this.fixAttempts.get(prKey) || 0;
    if (attempts >= (this.config.maxFixAttempts || 3)) {
      this.logger.warn({ prKey, attempts }, 'Max fix attempts reached, skipping auto-fix');
      
      // Post a comment explaining the situation (upsert to avoid spam)
      await this.upsertComment(owner, repo, prNumber, 
        `## ⚠️ Auto-Fix Limit Reached\n\n` +
        `The automation system has attempted to fix pipeline failures ${attempts} times but the issues persist.\n\n` +
        `**Human intervention required.**\n\n` +
        `Please review the failing checks and fix manually, or comment \`/autofix\` to allow additional fix attempts.`,
        PipelineMonitor.COMMENT_MARKERS.AUTO_FIX
      );
      return;
    }

    // Get full pipeline status
    const status = await this.getPRPipelineStatus(owner, repo, prNumber);
    if (!status || status.failures.length === 0) {
      return;
    }

    this.logger.info({
      prKey,
      failedChecks: status.failedChecks,
      attempt: attempts + 1,
    }, 'Analyzing pipeline failures');

    // Analyze failures
    const analyses = await this.analyzeFailures(status);
    
    // Filter to auto-fixable issues
    const autoFixable = analyses.filter(a => a.autoFixable && a.confidence >= 0.7);
    
    if (autoFixable.length === 0) {
      this.logger.info({ prKey }, 'No auto-fixable issues found');
      
      // Post analysis comment
      await this.postFailureAnalysisComment(owner, repo, prNumber, analyses);
      
      // Emit event so pipeline-automation can release lock and process queue
      this.emit('analysis:complete', { owner, repo, prNumber, fixAttempted: false, analyses });
      return;
    }

    // Attempt to fix if enabled
    if (this.config.autoFixEnabled) {
      this.fixAttempts.set(prKey, attempts + 1);
      
      // Run validator pre-check on generated fixes if available
      let validatorPassed = true;
      let validatorIssues: string[] = [];
      
      if (this.config.validateFixes) {
        try {
          const allFixes = autoFixable.flatMap(a => a.suggestedFixes);
          const validatorResult = await this.config.validateFixes(allFixes, {
            owner,
            repo,
            prNumber,
          });
          
          validatorPassed = validatorResult.passed;
          validatorIssues = validatorResult.issues;
          
          // Track validator result in learning service
          if (this.learningService) {
            this.learningService.recordValidatorResult(validatorPassed);
          }
          
          if (!validatorPassed) {
            this.logger.warn({
              owner,
              repo,
              prNumber,
              issues: validatorIssues,
            }, 'Validator pre-check failed, skipping fix application');
            
            await this.upsertComment(owner, repo, prNumber,
              `## ⚠️ Auto-Fix Validation Failed\n\n` +
              `Generated fixes did not pass validation:\n` +
              validatorIssues.map(i => `- ${i}`).join('\n') +
              `\n\n**Human intervention required.**`,
              PipelineMonitor.COMMENT_MARKERS.AUTO_FIX
            );
            
            // Emit event so pipeline-automation can release lock and process queue
            this.emit('analysis:complete', { owner, repo, prNumber, fixAttempted: false, validationFailed: true });
            return;
          }
          
          this.logger.info({ owner, repo, prNumber }, 'Validator pre-check passed');
        } catch (error) {
          this.logger.warn({ error }, 'Failed to run validator pre-check, proceeding anyway');
        }
      }
      
      // Record fix attempt in learning service BEFORE applying
      const attemptId = await this.recordLearningAttempt(owner, repo, prNumber, autoFixable);
      
      const fixResult = await this.applyFixes(owner, repo, prNumber, autoFixable);
      
      if (fixResult.success) {
        // Note: We don't call learnFromSuccess here because we need to wait
        // for the pipeline to actually pass. This is tracked in handlePRPipelineSuccess.
        await this.upsertComment(owner, repo, prNumber,
          `## 🔧 Auto-Fix Applied\n\n` +
          `Fixed ${fixResult.fixedIssues}/${fixResult.totalIssues} issues:\n\n` +
          fixResult.appliedFixes.map(f => `- **${f.file}**: ${f.description}`).join('\n') +
          `\n\nCommit: \`${fixResult.commitSha}\`\n\n` +
          `*The pipeline will re-run automatically.*`,
          PipelineMonitor.COMMENT_MARKERS.AUTO_FIX
        );
        
        // Emit event with learning tracking info
        this.emit('fix:applied', { 
          owner, 
          repo, 
          prNumber, 
          fixResult, 
          analyses: autoFixable,
          learningAttemptId: attemptId,
        });
      } else {
        // Learn from the failure immediately since the fix couldn't even be applied
        await this.recordLearningFailure(owner, repo, prNumber, autoFixable, fixResult.error || 'Fix application failed');
        
        await this.upsertComment(owner, repo, prNumber,
          `## ❌ Auto-Fix Failed\n\n` +
          `Unable to apply fixes: ${fixResult.error}\n\n` +
          `Please review the failing checks manually.`,
          PipelineMonitor.COMMENT_MARKERS.AUTO_FIX
        );
        
        this.emit('fix:failed', {
          owner,
          repo,
          prNumber,
          error: fixResult.error,
          analyses: autoFixable,
        });
      }
    } else {
      // Just post the analysis
      await this.postFailureAnalysisComment(owner, repo, prNumber, analyses);
      
      // Emit event so pipeline-automation can release lock and process queue
      this.emit('analysis:complete', { owner, repo, prNumber, fixAttempted: false, autoFixDisabled: true, analyses });
    }

    this.emit('pipeline:failure-processed', { owner, repo, prNumber, analyses });
  }

  /**
   * Record a fix attempt in the learning service
   */
  private async recordLearningAttempt(
    owner: string,
    repo: string,
    prNumber: number,
    analyses: PipelineFailureAnalysis[]
  ): Promise<string | null> {
    if (!this.learningService) {
      return null;
    }

    try {
      const attemptId = `${owner}/${repo}#${prNumber}-${Date.now()}`;
      
      // Get current attempt number for this PR
      const prKey = `${owner}/${repo}#${prNumber}`;
      const attemptNumber = this.fixAttempts.get(prKey) || 1;
      
      for (const analysis of analyses) {
        await this.learningService.recordFixAttempt({
          repo: `${owner}/${repo}`,
          prNumber,
          failureType: analysis.failureType,
          errorPattern: analysis.errorMessages.slice(0, 5).join('\n'),
          attemptNumber,
          successful: false, // Will be updated when we know the result
          appliedFixes: analysis.suggestedFixes.map(f => ({
            file: f.file,
            description: f.description,
          })),
        });
      }
      
      return attemptId;
    } catch (error) {
      this.logger.error({ error }, 'Failed to record fix attempt in learning service');
      return null;
    }
  }

  /**
   * Record a fix failure for learning
   */
  private async recordLearningFailure(
    owner: string,
    repo: string,
    prNumber: number,
    analyses: PipelineFailureAnalysis[],
    errorMessage: string
  ): Promise<void> {
    if (!this.learningService) {
      return;
    }

    try {
      // Get current attempt number for this PR
      const prKey = `${owner}/${repo}#${prNumber}`;
      const attemptNumber = this.fixAttempts.get(prKey) || 1;
      
      for (const analysis of analyses) {
        await this.learningService.recordFixAttempt({
          repo: `${owner}/${repo}`,
          prNumber,
          failureType: analysis.failureType,
          errorPattern: analysis.errorMessages.slice(0, 5).join('\n'),
          attemptNumber,
          successful: false,
          error: errorMessage,
          appliedFixes: analysis.suggestedFixes.map(f => ({
            file: f.file,
            description: f.description,
          })),
        });
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to record fix failure in learning service');
    }
  }

  /**
   * Record a fix success for learning
   */
  private async recordLearningSuccess(
    owner: string,
    repo: string,
    prNumber: number,
    analyses: PipelineFailureAnalysis[]
  ): Promise<void> {
    if (!this.learningService) {
      return;
    }

    try {
      // Get current attempt number for this PR
      const prKey = `${owner}/${repo}#${prNumber}`;
      const attemptNumber = this.fixAttempts.get(prKey) || 1;
      
      for (const analysis of analyses) {
        await this.learningService.recordFixAttempt({
          repo: `${owner}/${repo}`,
          prNumber,
          failureType: analysis.failureType,
          errorPattern: analysis.errorMessages.slice(0, 5).join('\n'),
          attemptNumber,
          successful: true,
          appliedFixes: analysis.suggestedFixes.map(f => ({
            file: f.file,
            description: f.description,
          })),
        });
      }
      
      this.logger.info({
        owner,
        repo,
        prNumber,
        failureTypes: analyses.map(a => a.failureType),
      }, 'Recorded successful fix in learning service');
    } catch (error) {
      this.logger.error({ error }, 'Failed to record fix success in learning service');
    }
  }

  /**
   * Handle PR pipeline success - post merge approval request and learn from success
   */
  async handlePRPipelineSuccess(owner: string, repo: string, prNumber: number): Promise<void> {
    const status = await this.getPRPipelineStatus(owner, repo, prNumber);
    if (!status || !status.allPassed) {
      return;
    }

    this.logger.info({
      owner,
      repo,
      prNumber,
      passedChecks: status.passedChecks,
    }, 'All pipeline checks passed');

    // Learn from successful fix if we had attempted one
    const prKey = `${owner}/${repo}#${prNumber}`;
    const hadFixAttempts = this.fixAttempts.has(prKey);
    
    if (hadFixAttempts && this.learningService) {
      // The pipeline passed after our fix - learn from this success!
      this.logger.info({ prKey }, 'Pipeline passed after fix attempt - learning from success');
      
      try {
        // We need to retrieve what fixes were applied from the learning service
        // or emit an event that the pipeline-automation can use
        this.emit('fix:successful', { owner, repo, prNumber });
        
        // Note: The actual learning happens in pipeline-automation which has
        // access to the full fix context from the fix:applied event
      } catch (error) {
        this.logger.error({ error }, 'Failed to learn from successful fix');
      }
    }

    // Clear fix attempts
    this.fixAttempts.delete(prKey);

    // Post merge approval request
    await this.postMergeApprovalRequest(owner, repo, prNumber, status);

    this.emit('pipeline:all-passed', { owner, repo, prNumber, status });
  }

  /**
   * Post failure analysis comment
   * Uses upsert pattern to update existing comment instead of creating spam
   */
  private async postFailureAnalysisComment(
    owner: string,
    repo: string,
    prNumber: number,
    analyses: PipelineFailureAnalysis[]
  ): Promise<void> {
    let comment = `## 🔍 Pipeline Failure Analysis\n\n`;
    
    for (const analysis of analyses) {
      comment += `### ❌ ${analysis.checkRunName}\n`;
      comment += `**Type:** ${analysis.failureType}\n`;
      comment += `**Auto-Fixable:** ${analysis.autoFixable ? '✅ Yes' : '❌ No'}\n`;
      comment += `**Confidence:** ${Math.round(analysis.confidence * 100)}%\n\n`;
      
      if (analysis.errorMessages.length > 0) {
        comment += `**Errors:**\n`;
        for (const msg of analysis.errorMessages.slice(0, 5)) {
          comment += `- \`${msg.slice(0, 200)}\`\n`;
        }
        if (analysis.errorMessages.length > 5) {
          comment += `- ... and ${analysis.errorMessages.length - 5} more\n`;
        }
        comment += '\n';
      }
      
      if (analysis.suggestedFixes.length > 0) {
        comment += `**Suggested Fixes:**\n`;
        for (const fix of analysis.suggestedFixes.slice(0, 3)) {
          comment += `- **${fix.file}**: ${fix.description}\n`;
          if (fix.suggestedCode) {
            comment += `  \`\`\`\n  ${fix.suggestedCode.slice(0, 200)}\n  \`\`\`\n`;
          }
        }
        comment += '\n';
      }
    }

    if (analyses.some(a => a.autoFixable)) {
      comment += `---\n\n💡 **Tip:** Comment \`/autofix\` to attempt automatic fixes.\n`;
    }

    comment += `\n---\n*Analysis by XORNG Pipeline Monitor*`;

    // Use upsert to update existing analysis comment instead of creating new ones
    await this.upsertComment(owner, repo, prNumber, comment, PipelineMonitor.COMMENT_MARKERS.PIPELINE_ANALYSIS);
  }

  /**
   * Post merge approval request when all checks pass
   * Uses upsert pattern to update existing comment instead of creating spam
   */
  private async postMergeApprovalRequest(
    owner: string,
    repo: string,
    prNumber: number,
    status: PRPipelineStatus
  ): Promise<void> {
    const comment = `## ✅ All Pipeline Checks Passed!\n\n` +
      `**Summary:**\n` +
      `- Total Checks: ${status.totalChecks}\n` +
      `- Passed: ${status.passedChecks}\n` +
      `- Failed: ${status.failedChecks}\n\n` +
      `---\n\n` +
      `🚀 **This PR is ready for human review and merge.**\n\n` +
      `### Actions:\n` +
      `- Comment \`/approve\` to approve the PR\n` +
      `- Comment \`/merge\` to merge the PR (requires approval)\n` +
      `- Comment \`/merge squash\` to squash and merge\n\n` +
      `---\n*Human-in-the-loop approval required per XORNG guidelines.*\n` +
      `*Automation by XORNG Pipeline Monitor*`;

    // Use upsert to update existing merge request comment
    await this.upsertComment(owner, repo, prNumber, comment, PipelineMonitor.COMMENT_MARKERS.MERGE_REQUEST);
    
    // Add a label to indicate readiness
    await this.addLabel(owner, repo, prNumber, 'ready-for-review');
  }

  /**
   * Apply fixes to the PR branch
   */
  async applyFixes(
    owner: string,
    repo: string,
    prNumber: number,
    analyses: PipelineFailureAnalysis[]
  ): Promise<PipelineFixResult> {
    const result: PipelineFixResult = {
      success: false,
      fixedIssues: 0,
      totalIssues: analyses.length,
      appliedFixes: [],
    };

    try {
      // Get PR details
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      const branch = pr.head.ref;

      // Collect all fixes
      const fixes: Array<{
        path: string;
        content: string;
        description: string;
      }> = [];

      for (const analysis of analyses) {
        for (const fix of analysis.suggestedFixes) {
          // Get current file content
          try {
            const { data: fileData } = await this.octokit.repos.getContent({
              owner,
              repo,
              path: fix.file,
              ref: branch,
            });

            if ('content' in fileData) {
              const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
              
              // Apply the fix (simplified - in reality this would be more sophisticated)
              let newContent = currentContent;
              if (fix.originalCode && fix.suggestedCode) {
                newContent = currentContent.replace(fix.originalCode, fix.suggestedCode);
              } else if (fix.lineStart && fix.lineEnd && fix.suggestedCode) {
                const lines = currentContent.split('\n');
                lines.splice(fix.lineStart - 1, fix.lineEnd - fix.lineStart + 1, fix.suggestedCode);
                newContent = lines.join('\n');
              }

              if (newContent !== currentContent) {
                fixes.push({
                  path: fix.file,
                  content: newContent,
                  description: fix.description,
                });
              }
            }
          } catch (error: unknown) {
            // Handle 404 errors specifically - file doesn't exist on this branch
            const httpError = error as { status?: number };
            if (httpError.status === 404) {
              this.logger.info({ 
                file: fix.file, 
                branch,
                suggestion: 'File may need to be created or AI suggested wrong file'
              }, 'File does not exist on branch, skipping fix');
              
              // If this is a new file suggestion (has full content), we could create it
              if (fix.suggestedCode && !fix.originalCode && !fix.lineStart) {
                this.logger.info({ file: fix.file }, 'Treating as new file creation');
                fixes.push({
                  path: fix.file,
                  content: fix.suggestedCode,
                  description: `Create new file: ${fix.description}`,
                });
              }
            } else {
              this.logger.warn({ error, file: fix.file }, 'Failed to get file content for fix');
            }
          }
        }
      }

      if (fixes.length === 0) {
        result.error = 'No fixes could be applied';
        return result;
      }

      // Create a commit with all fixes
      // First, get the current tree
      const { data: ref } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });

      const { data: commit } = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: ref.object.sha,
      });

      // Create blobs for each file
      const blobs = await Promise.all(
        fixes.map(async (fix) => {
          const { data: blob } = await this.octokit.git.createBlob({
            owner,
            repo,
            content: Buffer.from(fix.content).toString('base64'),
            encoding: 'base64',
          });
          return {
            path: fix.path,
            sha: blob.sha,
            mode: '100644' as const,
            type: 'blob' as const,
          };
        })
      );

      // Create tree
      const { data: tree } = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: commit.tree.sha,
        tree: blobs,
      });

      // Create commit
      const { data: newCommit } = await this.octokit.git.createCommit({
        owner,
        repo,
        message: `fix: auto-fix pipeline failures\n\n🤖 Automated fixes applied by XORNG Pipeline Monitor:\n${fixes.map(f => `- ${f.path}: ${f.description}`).join('\n')}`,
        tree: tree.sha,
        parents: [ref.object.sha],
      });

      // Update branch reference
      await this.octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      result.success = true;
      result.fixedIssues = fixes.length;
      result.commitSha = newCommit.sha;
      result.appliedFixes = fixes.map(f => ({
        file: f.path,
        description: f.description,
        changeType: 'modify' as const,
      }));

      this.logger.info({
        owner,
        repo,
        prNumber,
        commitSha: newCommit.sha,
        fixedFiles: fixes.length,
      }, 'Applied auto-fixes');

      return result;
    } catch (error: any) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to apply fixes');
      result.error = error.message || 'Unknown error';
      return result;
    }
  }

  /**
   * Handle /autofix command in PR comments
   */
  async handleAutoFixCommand(owner: string, repo: string, prNumber: number, sender: string): Promise<void> {
    const prKey = `${owner}/${repo}#${prNumber}`;
    
    // Reset fix attempts
    this.fixAttempts.delete(prKey);
    
    // Use upsert to update the fix status comment
    await this.upsertComment(owner, repo, prNumber,
      `## 🔧 Auto-Fix Triggered\n\n` +
      `@${sender} requested an automatic fix attempt.\n\n` +
      `Analyzing pipeline failures...`,
      PipelineMonitor.COMMENT_MARKERS.FIX_TRIGGERED
    );

    await this.handlePRPipelineFailure(owner, repo, prNumber);
  }

  /**
   * Comment marker types for upsert operations
   * Each marker identifies a specific type of bot comment to update instead of creating new ones
   */
  private static readonly COMMENT_MARKERS = {
    PIPELINE_ANALYSIS: '<!-- XORNG-PIPELINE-ANALYSIS -->',
    AUTO_FIX: '<!-- XORNG-AUTO-FIX -->',
    MERGE_REQUEST: '<!-- XORNG-MERGE-REQUEST -->',
    FIX_TRIGGERED: '<!-- XORNG-FIX-TRIGGERED -->',
    INTERVENTION: '<!-- XORNG-INTERVENTION -->',
  } as const;

  /**
   * Find an existing comment by marker
   * Returns the comment ID if found, null otherwise
   */
  private async findCommentByMarker(
    owner: string, 
    repo: string, 
    prNumber: number, 
    marker: string
  ): Promise<number | null> {
    try {
      const { data: comments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existingComment = comments.find(comment => 
        comment.body?.includes(marker)
      );

      return existingComment?.id ?? null;
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber, marker }, 'Failed to list comments for marker search');
      return null;
    }
  }

  /**
   * Create or update a comment (upsert pattern)
   * Best practice: Use markers to identify bot comments and update them instead of creating spam
   * 
   * @param owner Repository owner
   * @param repo Repository name
   * @param prNumber Pull request number
   * @param body Comment body (marker will be prepended)
   * @param marker Hidden HTML marker to identify the comment type
   */
  private async upsertComment(
    owner: string, 
    repo: string, 
    prNumber: number, 
    body: string,
    marker: string
  ): Promise<void> {
    // Add timestamp to show when comment was last updated
    const timestamp = new Date().toISOString();
    const bodyWithMarker = `${marker}\n${body}\n\n<sub>Last updated: ${timestamp}</sub>`;

    try {
      const existingCommentId = await this.findCommentByMarker(owner, repo, prNumber, marker);

      if (existingCommentId) {
        // Update existing comment
        await this.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: existingCommentId,
          body: bodyWithMarker,
        });
        this.logger.debug({ owner, repo, prNumber, marker }, 'Updated existing comment');
      } else {
        // Create new comment
        await this.octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: bodyWithMarker,
        });
        this.logger.debug({ owner, repo, prNumber, marker }, 'Created new comment');
      }
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber, marker }, 'Failed to upsert comment');
    }
  }

  /**
   * Post a comment on a PR (creates a new comment)
   * Use upsertComment for bot status updates to avoid comment spam
   */
  private async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to post comment');
    }
  }

  /**
   * Add a label to a PR
   */
  private async addLabel(owner: string, repo: string, prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [label],
      });
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber, label }, 'Failed to add label');
    }
  }

  /**
   * Re-run failed checks
   */
  async rerunFailedChecks(owner: string, repo: string, runId: number): Promise<boolean> {
    try {
      await this.octokit.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: runId,
      });
      this.logger.info({ owner, repo, runId }, 'Re-ran failed jobs');
      return true;
    } catch (error) {
      this.logger.error({ error, owner, repo, runId }, 'Failed to re-run failed jobs');
      return false;
    }
  }
}
