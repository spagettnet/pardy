/**
 * Centralized LLM client. Supports two backends:
 *   - Direct Anthropic (set ANTHROPIC_API_KEY)
 *   - OpenRouter via Anthropic-compatible endpoint (set OPENROUTER_API_KEY)
 *
 * OpenRouter mode prefixes model IDs with "anthropic/" by default and
 * disables Anthropic-only server-side tools (e.g. web_search) since
 * OpenRouter doesn't proxy them.
 */

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
// Anthropic SDK appends `/v1/messages` to baseURL, so omit `/v1` here.
const OPENROUTER_BASE =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api";
const OPENROUTER_MODEL_PREFIX =
  process.env.OPENROUTER_MODEL_PREFIX ?? "anthropic/";

export const useOpenRouter = !ANTHROPIC_KEY && !!OPENROUTER_KEY;
export const hasLlm = !!(ANTHROPIC_KEY || OPENROUTER_KEY);

export const client: Anthropic | null = (() => {
  if (ANTHROPIC_KEY) {
    return new Anthropic({ apiKey: ANTHROPIC_KEY });
  }
  if (OPENROUTER_KEY) {
    return new Anthropic({
      apiKey: OPENROUTER_KEY,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        // OpenRouter likes a referrer + title for analytics; harmless if missing.
        "HTTP-Referer": "https://github.com/local/pardy",
        "X-Title": "Pardy (local Jeopardy)",
      },
    });
  }
  return null;
})();

export function modelId(baseId: string): string {
  if (useOpenRouter && !baseId.includes("/")) {
    return `${OPENROUTER_MODEL_PREFIX}${baseId}`;
  }
  return baseId;
}

/**
 * Returns the model string with web-search enabled for the active backend.
 * - OpenRouter: appends `:online` to trigger their built-in web search via Exa.
 * - Anthropic direct: returns the bare model — caller should also pass the
 *   `web_search_20260209` server tool in the tools array.
 */
export function modelWithWebSearch(baseId: string): string {
  const m = modelId(baseId);
  if (useOpenRouter) {
    // Don't double-suffix
    if (m.endsWith(":online")) return m;
    return `${m}:online`;
  }
  return m;
}

export function describeBackend(): string {
  if (ANTHROPIC_KEY) return "Anthropic (direct)";
  if (OPENROUTER_KEY) return `OpenRouter (${OPENROUTER_BASE})`;
  return "no LLM configured";
}

/**
 * Anthropic-only server tools (web_search, code_execution, etc.) don't
 * proxy through OpenRouter — gate them on this.
 */
export const supportsServerTools = !useOpenRouter;
