// prompt.ts — Dynamic system prompt assembly
// Reads markdown files from workspace/ and discovers skills from workspace/skills/.
// Workspace files (SOUL, VOICE) are loaded directly into the prompt.
// Skills are listed by name + description so the agent knows what's available
// and can read the full INSTRUCTIONS.md on demand.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const MAX_FILE_CHARS = 20_000;   // max chars per workspace file
const MAX_TOTAL_CHARS = 150_000; // max chars for the entire assembled prompt

// Load order — controls which sections appear first in the prompt.
const WORKSPACE_FILES = [
  "SOUL.md",       // who the agent is
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

// Parse YAML-ish frontmatter from a skill's INSTRUCTIONS.md
function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();

  // description can be a single line or a multiline | block
  // For multiline, collect indented lines (2+ spaces) after "description: |"
  let description: string | undefined;
  const descIdx = block.indexOf("description:");
  if (descIdx !== -1) {
    const afterDesc = block.slice(descIdx + "description:".length).trimStart();
    if (afterDesc.startsWith("|")) {
      // Multiline: grab all lines indented with 2+ spaces
      const lines = afterDesc.slice(1).split("\n").slice(1); // skip the | line
      const indented: string[] = [];
      for (const line of lines) {
        if (/^ {2}/.test(line)) {
          indented.push(line.replace(/^ {2}/, ""));
        } else {
          break;
        }
      }
      description = indented.join(" ").trim();
    } else {
      // Single line
      description = afterDesc.split("\n")[0].trim();
    }
  }

  if (!name || !description) return null;
  return { name, description };
}

// Discover skills from workspace/skills/*/INSTRUCTIONS.md
function discoverSkills(workspacePath: string): { name: string; description: string; path: string }[] {
  const skillsDir = join(workspacePath, "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: { name: string; description: string; path: string }[] = [];

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const instrPath = join(skillsDir, entry.name, "INSTRUCTIONS.md");
    if (!existsSync(instrPath)) continue;

    const content = readFileSync(instrPath, "utf-8");
    const meta = parseFrontmatter(content);
    if (meta) {
      skills.push({ ...meta, path: instrPath });
    }
  }

  return skills;
}

// Build the full system prompt from workspace files + skill index
export function buildSystemPrompt(workspacePath: string): string {
  const sections: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    const content = loadWorkspaceFile(workspacePath, filename);
    if (content) {
      sections.push(content);
    }
  }

  // Discover and list available skills
  const skills = discoverSkills(workspacePath);
  if (skills.length > 0) {
    const lines = ["# Available Skills", ""];
    lines.push("Read a skill's instructions before you need it — for CLI tools, reference info, or practice knowledge. Use the bash tool to run CLI commands.");
    lines.push("");
    for (const skill of skills) {
      lines.push(`- **${skill.name}** — ${skill.description}`);
      lines.push(`  Instructions: \`${skill.path}\``);
    }
    sections.push(lines.join("\n"));
  }

  let prompt = sections.join("\n\n---\n\n");

  if (prompt.length > MAX_TOTAL_CHARS) {
    prompt = prompt.slice(0, MAX_TOTAL_CHARS) + "\n\n[... truncated]";
  }

  return prompt;
}
