import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Model } from "@mariozechner/pi-ai";

// Root of the project — one level up from src/
const ROOT = join(import.meta.dirname, "..");

// Shape of config.json — tells us which model to use and how to connect
interface Config {
  provider: string;      // e.g. "baseten" — identifies the LLM provider
  model: string;         // e.g. "openai/gpt-oss-120b" — the model ID
  baseUrl: string;       // e.g. "https://inference.baseten.co/v1" — API endpoint
  apiKeyEnv: string;     // e.g. "BASETEN_API_KEY" — which env var holds the key
  contextWindow: number; // max tokens the model can see (input + output)
  maxTokens: number;     // max tokens the model can generate per response
  telephony?: TelephonyConfig;
}

export interface TelephonyConfig {
  enabled: boolean;
  port: number;
  twilio: {
    accountSid: string;      // Twilio Account SID (starts with AC)
    authToken: string;       // Twilio Auth Token
    phoneNumber: string;     // your Twilio phone number
  };
  elevenlabs: {
    apiKey: string;          // ElevenLabs API key
    voiceId: string;         // ElevenLabs voice ID
    modelId: string;         // ElevenLabs model (e.g. eleven_turbo_v2_5)
  };
  asr: {
    provider: "elevenlabs";  // ASR provider
    language: string;        // e.g. "en"
  };
}

// Read config from file (local dev) or CONFIG_JSON env var (Railway/production)
export function loadConfig(): Config {
  if (process.env.CONFIG_JSON) {
    return JSON.parse(process.env.CONFIG_JSON);
  }
  const configPath = join(ROOT, "config.json");
  if (!existsSync(configPath)) {
    throw new Error("No config.json found and CONFIG_JSON env var not set");
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

// Resolve telephony credentials from environment variables.
// Returns null if telephony is not configured or not enabled.
export function getTelephonyCredentials(config: Config) {
  if (!config.telephony?.enabled) return null;

  const { twilio, elevenlabs } = config.telephony;

  const accountSid = twilio.accountSid;
  const authToken = twilio.authToken;
  const elevenlabsApiKey = elevenlabs.apiKey;

  if (!accountSid) throw new Error(`Set twilio.accountSid in config.json`);
  if (!authToken) throw new Error(`Set twilio.authToken in config.json`);
  if (!elevenlabsApiKey) throw new Error(`Set elevenlabs.apiKey in config.json`);

  return { accountSid, authToken, elevenlabsApiKey };
}

// Pull the API key from the environment variable named in config.apiKeyEnv
export function getApiKey(config: Config): string {
  const key = process.env[config.apiKeyEnv];
  if (!key) {
    throw new Error(`Set ${config.apiKeyEnv} environment variable`);
  }
  return key;
}

// Build a pi-ai Model object from our config.
// We use "openai-completions" as the API type because our provider
// (Baseten) exposes an OpenAI-compatible chat completions endpoint.
// This same pattern works for any OpenAI-compatible provider
// (Ollama, vLLM, LM Studio, Together, etc.)
export function createModel(config: Config): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",  // tells pi-ai to use OpenAI chat completions format
    provider: config.provider,
    baseUrl: config.baseUrl,    // the custom endpoint URL
    reasoning: false,           // this model doesn't support extended thinking
    input: ["text"],            // text-only input (no image support)
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // no cost tracking yet
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
}
