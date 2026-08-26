// One place for every LLM constant and the single structured call the game
// makes (booth-mode commentary). Rules honored here:
//   - model names live only in these constants
//   - structured output with a JSON schema, validated, one retry, then one
//     escalation to the bigger model (logged)
//   - results cached by ride-trace content hash so nothing is paid for twice
//   - tokens in/out logged per call
// The key is the player's own, pasted in the UI, held in localStorage only.

export const LLM_MODEL = "claude-haiku-4-5";
export const LLM_ESCALATION_MODEL = "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 8000;

const SYSTEM = [
  {
    type: "text",
    text: "You are a WSL broadcast booth: a commentator and a coach. Judging criteria: commitment and degree of difficulty, innovative and progressive maneuvers, combination of major maneuvers, variety, speed power and flow. Reply only with JSON matching the requested schema. commentary: one line of live broadcast commentary, under 90 characters, energetic but precise, no score numbers, no quotes. coach: one concrete tip for the next wave drawn from the telemetry, under 80 characters.",
    cache_control: { type: "ephemeral" },
  },
];

const SCHEMA = {
  type: "object",
  properties: {
    commentary: { type: "string", maxLength: 110 },
    coach: { type: "string", maxLength: 90 },
  },
  required: ["commentary", "coach"],
  additionalProperties: false,
};

function traceHash(obj) {
  let h = 2166136261;
  const s = JSON.stringify(obj);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function callOnce(key, model, userText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        system: SYSTEM,
        output_format: { type: "json_schema", schema: SCHEMA },
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.usage) {
      console.log(`[llm] ${model} tokens in=${data.usage.input_tokens} out=${data.usage.output_tokens}`);
    }
    const text = data.content?.find((b) => b.type === "text")?.text;
    const parsed = JSON.parse(text);
    if (typeof parsed.commentary === "string" && parsed.commentary.length) {
      return {
        commentary: parsed.commentary.slice(0, 110),
        coach: typeof parsed.coach === "string" ? parsed.coach.slice(0, 90) : "",
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns {commentary, coach} or null (caller falls back to the template bank).
// One structured call per ride covers both features.
export async function boothCommentary(key, trace, score, breakName) {
  if (!key) return null;
  const cacheKey = "dp_llm_" + traceHash({ trace, score });
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* fall through to a fresh call */ }

  const userText = `Ride at ${breakName}, judged ${score.toFixed(2)}. Telemetry: ${JSON.stringify(trace)}. Return commentary (one live broadcast line) and coach (one specific tip for the next wave based on the telemetry).`;
  let out = await callOnce(key, LLM_MODEL, userText);      // first attempt
  if (!out) out = await callOnce(key, LLM_MODEL, userText); // one retry
  if (!out) {
    console.warn("[llm] escalating one call to", LLM_ESCALATION_MODEL);
    out = await callOnce(key, LLM_ESCALATION_MODEL, userText);
  }
  if (out) {
    try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch { /* storage full: fine */ }
  }
  return out;
}
