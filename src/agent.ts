import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { join } from "path";
import { buildSystemPrompt } from "./prompt.js";

export interface AgentOptions {
  model: Model<"openai-completions">;
  apiKey: string;
  cwd: string;            // working directory the agent operates in
  resumeSession?: boolean; // if true, continue the most recent session instead of starting fresh
}

export async function startAgent(options: AgentOptions): Promise<AgentSession> {
  const { model, apiKey, cwd, resumeSession } = options;

  // --- Auth ---
  // AuthStorage is pi-coding-agent's credential system.
  // We inject our API key at runtime so the agent can authenticate
  // with the LLM provider without needing ~/.pi/agent/auth.json
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(model.provider, apiKey);

  // ModelRegistry tracks available models + which ones have valid keys.
  // It uses authStorage to check which providers are authenticated.
  const modelRegistry = new ModelRegistry(authStorage);

  // --- Sessions ---
  // SessionManager handles saving/loading conversation history as JSONL files.
  // continueRecent() resumes the last session; create() starts a new one.
  // Sessions are stored in .sessions/ under the cwd.
  const sessionManager = resumeSession
    ? SessionManager.continueRecent(cwd)
    : SessionManager.create(cwd);

  // --- System Prompt ---
  // buildSystemPrompt() reads workspace/ files (SOUL.md, VOICE.md, etc.)
  // and assembles them into a single prompt with runtime context.
  // Edit the files in workspace/ to change the agent's behavior.
  const workspacePath = join(cwd, "workspace");
  const systemPrompt = buildSystemPrompt(workspacePath);

  const resourceLoader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  // --- Create the session ---
  // This wires everything together: model, tools, auth, sessions, prompt.
  // createAgentSession returns a session object that we use to send prompts
  // and subscribe to streaming events.
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",                // no extended thinking for now
    tools: createCodingTools(cwd),       // read, write, edit, bash tools — scoped to cwd
    sessionManager,
    resourceLoader,
    authStorage,
    modelRegistry,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },     // auto-summarize old messages when context fills up
      retry: { enabled: true, maxRetries: 2 }, // retry failed LLM calls up to 2 times
    }),
  });

  return session;
}
