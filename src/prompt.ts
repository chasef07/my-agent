// prompt.ts — Dynamic system prompt assembly
// Reads markdown files from workspace/ and concatenates them into a single system prompt.
// Files are loaded in a defined order. Missing files are skipped.
// Each file is truncated to MAX_FILE_CHARS to stay within context limits.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const MAX_FILE_CHARS = 20_000;   // max chars per workspace file
const MAX_TOTAL_CHARS = 150_000; // max chars for the entire assembled prompt

// Load order — controls which sections appear first in the prompt.
// Add new workspace files here as they're created.
const WORKSPACE_FILES = [
  "SOUL.md",       // who the agent is
  "VOICE.md",      // how the agent speaks
  "IDENTITY.md",   // name, characteristics
  "AGENTS.md",     // operating instructions
  "USER.md",       // user profile and preferences
  "TOOLS.md",      // tool usage guidance
  "MEMORY.md",     // long-term memory snapshot
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

// Scan workspace/skills/ for skill directories.
// Each skill must have a SKILL.md with a "# name" heading and optional description.
// Returns a compact XML manifest the agent can reference, or null if no skills found.
function buildSkillsManifest(workspacePath: string): string | null {
  const skillsDir = join(workspacePath, "skills");
  if (!existsSync(skillsDir)) return null;

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (skillDirs.length === 0) return null;

  const skills: string[] = [];

  for (const dir of skillDirs) {
    const skillPath = join(skillsDir, dir.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const content = readFileSync(skillPath, "utf-8").trim();
    if (!content) continue;

    // Parse YAML frontmatter (--- delimited) for name and description
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    let name = dir.name;
    let description = "";

    if (frontmatter) {
      const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    skills.push(`  <skill>
    <name>${name}</name>
    <description>${description}</description>
    <location>${skillPath}</location>
  </skill>`);
  }

  if (skills.length === 0) return null;

  return `# Skills

When you need to use a skill, read its SKILL.md at the listed location to get full instructions.

<available_skills>
${skills.join("\n")}
</available_skills>`;
}

// Build the full system prompt from workspace files + runtime context
export function buildSystemPrompt(workspacePath: string): string {
  const sections: string[] = [];

  // Load each workspace file in order
  for (const filename of WORKSPACE_FILES) {
    const content = loadWorkspaceFile(workspacePath, filename);
    if (content) {
      sections.push(content);
    }
  }

  // Build compact skills manifest — only names, descriptions, and file paths.
  // The agent uses the read tool to load a skill's full SKILL.md when it needs it.
  const skillsManifest = buildSkillsManifest(workspacePath);
  if (skillsManifest) {
    sections.push(skillsManifest);
  }

  // Add runtime context
  sections.push(`# Runtime Context
- Date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
- Platform: ${process.platform}
- Working directory: ${process.cwd()}`);

  // Join all sections and enforce total limit
  let prompt = sections.join("\n\n---\n\n");

  if (prompt.length > MAX_TOTAL_CHARS) {
    prompt = prompt.slice(0, MAX_TOTAL_CHARS) + "\n\n[... prompt truncated]";
  }

  return prompt;
}
