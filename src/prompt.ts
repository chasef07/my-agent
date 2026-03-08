// prompt.ts — Dynamic system prompt assembly
// Reads markdown files from workspace/ and concatenates them into a single system prompt.
// Files are loaded in a defined order. Missing files are skipped.
// Each file is truncated to MAX_FILE_CHARS to stay within context limits.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MAX_FILE_CHARS = 20_000;   // max chars per workspace file
const MAX_TOTAL_CHARS = 150_000; // max chars for the entire assembled prompt

// Load order — controls which sections appear first in the prompt.
// Add new workspace files here as they're created.
const WORKSPACE_FILES = [
  "SOUL.md",       // who the agent is
  "TOOLS.md",      // CLI tools (amd, etc.)
  "VOICE.md",      // how the agent speaks
];

// Read a workspace file, truncate if needed, return null if missing
function loadWorkspaceFile(workspacePath: string, filename: string): string | null {
  const filePath = join(workspacePath, filename);
  if (!existsSync(filePath)) return null;

  let content = readFileSync(filePath, "utf-8").trim();
  if (!content) return null;

  if (content.length > MAX_FILE_CHARS) {
    content = content.slice(0, MAX_FILE_CHARS) + "\n\n[... truncated]";
  }

  return content;
}

// Build the full system prompt from workspace files
export function buildSystemPrompt(workspacePath: string): string {
  const sections: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    const content = loadWorkspaceFile(workspacePath, filename);
    if (content) {
      sections.push(content);
    }
  }

  let prompt = sections.join("\n\n---\n\n");

  if (prompt.length > MAX_TOTAL_CHARS) {
    prompt = prompt.slice(0, MAX_TOTAL_CHARS) + "\n\n[... truncated]";
  }

  return prompt;
}
