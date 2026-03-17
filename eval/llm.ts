// eval/llm.ts — Claude API client for scenario generation, judging, and proposals

function extractJson(text: string): any {
  // Try direct parse first
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}

  // Strip markdown code fences
  const fenced = trimmed.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  try { return JSON.parse(fenced); } catch {}

  // Find first { or [ and extract the JSON from mixed text
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) throw new Error(`No JSON found in response: ${text.slice(0, 100)}`);

  const isArray = text[start] === "[";
  const closeChar = isArray ? "]" : "}";

  // Find the matching closing bracket by counting depth
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") depth++;
    if (text[i] === "}" || text[i] === "]") depth--;
    if (depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }

  throw new Error(`Unbalanced JSON in response: ${text.slice(0, 100)}`);
}

export async function callJson(
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  maxTokens = 4096,
): Promise<any> {
  const isOAuth = apiKey.startsWith("sk-ant-oat");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };

      if (isOAuth) {
        headers["authorization"] = `Bearer ${apiKey}`;
      } else {
        headers["x-api-key"] = apiKey;
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json() as any;
      const text = data.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") ?? "";

      return extractJson(text);
    } catch (err) {
      if (attempt === 2) throw err;
      console.error(`  [llm] Attempt ${attempt + 1} failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
