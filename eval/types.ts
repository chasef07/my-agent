// eval/types.ts — Shared types for the eval system

export interface Scenario {
  id: string;
  personaName: string;
  personaBackground: string;
  difficulty: "A" | "B" | "C" | "D";
  attackStrategy: string;
  callerScript: string[];
  agentShould: string[];
  agentShouldNot: string[];
}

export interface ToolCallRecord {
  name: string;
  args: any;
  result?: string;
  isError: boolean;
  durationMs: number;
}

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  toolCalls?: ToolCallRecord[];
}

export interface ConversationResult {
  scenario: Scenario;
  turns: ConversationTurn[];
  transcript: string;
}

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  evidence: string;
  reasoning: string;
}

export interface Issue {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestedFix: string;
}

export interface EvalResult {
  scenarioId: string;
  score: number;
  csatScore: number;
  passed: boolean;
  summary: string;
  shouldResults: CriterionResult[];
  shouldNotResults: CriterionResult[];
  failureModes: string[];
  issues: Issue[];
}

export interface ExperimentRecord {
  number: number;
  description: string;
  changeType: "add" | "modify" | "remove" | "none";
  score: number;
  baselineScore: number;
  status: "keep" | "discard" | "baseline";
  promptChars: number;
  evalResults: EvalResult[];
}

export interface EvalConfig {
  anthropicApiKey: string;
  evalModel: string;
  numScenarios: number;
  maxExperiments: number;
  maxTurns: number;
  improvementThreshold: number;
  scoring: {
    shouldWeight: number;
    shouldNotWeight: number;
    latencyWeight: number;
    latencyThresholdMs: number;
  };
}
