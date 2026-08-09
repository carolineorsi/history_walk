// History Walk — "Tell me more" AI description proxy.
//
// This Cloudflare Worker is the only piece of the app that needs a secret
// API key, so it lives server-side rather than in browser JS. It does
// exactly one thing: given a historical site the client already found
// (name + OpenStreetMap/NRHP tags), write a short, grounded description —
// using Anthropic's web_search tool to look up real facts when the model
// isn't already confident about the place. It never discovers places
// itself and never returns coordinates; those always come straight from
// OpenStreetMap, Wikipedia, or the National Register of Historic Places,
// queried directly by the browser (see js/app.js). A search never adds a
// new place to the map, only detail to one already found.
//
// Endpoint (POST, JSON body):
//
//   { action: "describe", points: [{id, name, tags}, ...] }
//     -> { descriptions: [{id, description}, ...] }
//     `points` should be capped client-side (<=20) — each one costs tokens,
//     and a place the model isn't already confident about may cost an
//     extra web search (see MAX_WEB_SEARCHES_PER_DESCRIBE below). In
//     practice the client only ever calls this with one point at a time,
//     on demand when someone taps a pin's "Tell me more" button.
//
// Cost controls: only the app's own origin may call this (checked against
// the ALLOWED_ORIGINS var below), and every request is rate-limited both
// per-IP and with a hard daily global cap (via the RATE_LIMIT_KV binding)
// so a scraper that finds this URL and calls it directly — bypassing the
// browser and any CORS check entirely — still can't run up an unbounded
// bill. Also set a spend limit on the Anthropic Console itself as a backstop
// that doesn't depend on this Worker's logic at all. See README.md.
//
// Deploy:
//   1. npm install -g wrangler   (if you don't have it already)
//   2. wrangler kv namespace create RATE_LIMIT_KV
//      -> paste the returned id into the [[kv_namespaces]] block in wrangler.toml
//   3. wrangler secret put ANTHROPIC_API_KEY     (paste your key when prompted)
//   4. Edit the [vars] block in wrangler.toml: ALLOWED_ORIGINS should list
//      every origin this Worker should accept calls from (comma-separated).
//   5. wrangler deploy
//   6. Copy the deployed *.workers.dev URL into AI_PROXY_BASE in js/app.js

const ANTHROPIC_VERSION = "2023-06-01";
// Haiku is the cheap/fast tier — the quality of these descriptions comes
// from web_search actually running (see WEB_SEARCH_TOOL below), not from a
// stronger model. Bump this to a Sonnet model id if you want to trade cost
// for writing quality.
const DESCRIBE_MODEL = "claude-haiku-4-5-20251001";
const MAX_POINTS_PER_DESCRIBE = 20;
// Not every point needs a lookup (well-known sites the model already
// knows), so this is a ceiling, not a per-point guarantee.
const MAX_WEB_SEARCHES_PER_DESCRIBE = 10;
const DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_IP = 12;
const DEFAULT_MAX_DAILY_REQUESTS = 400;

function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

// Best-effort — Workers KV reads/writes aren't atomic, so under heavy
// concurrent abuse a few requests could slip past the exact limit. That's
// fine here: this is a deterrent against runaway cost, not a precise
// billing meter (the real backstop is the spend limit on the Anthropic
// Console — see README.md).
async function checkAndIncrementRateLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const ipKey = `ip:${ip}:${minuteBucket}`;
  const dayBucket = new Date(now).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const globalKey = `global:${dayBucket}`;

  const [ipCountStr, globalCountStr] = await Promise.all([
    env.RATE_LIMIT_KV.get(ipKey),
    env.RATE_LIMIT_KV.get(globalKey),
  ]);
  const ipCount = parseInt(ipCountStr || "0", 10);
  const globalCount = parseInt(globalCountStr || "0", 10);

  const maxPerIp = parseInt(env.MAX_REQUESTS_PER_MINUTE_PER_IP, 10) || DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_IP;
  const maxGlobal = parseInt(env.MAX_DAILY_REQUESTS, 10) || DEFAULT_MAX_DAILY_REQUESTS;

  if (globalCount >= maxGlobal) {
    return { ok: false, reason: "This app's daily AI search limit has been reached — try again tomorrow." };
  }
  if (ipCount >= maxPerIp) {
    return { ok: false, reason: "Too many searches — wait a minute and try again." };
  }

  await Promise.all([
    env.RATE_LIMIT_KV.put(ipKey, String(ipCount + 1), { expirationTtl: 120 }),
    env.RATE_LIMIT_KV.put(globalKey, String(globalCount + 1), { expirationTtl: 90000 }),
  ]);

  return { ok: true };
}

const DESCRIBE_TOOL = {
  name: "emit_descriptions",
  description: "Write a richer description for each historical site, one entry per id given.",
  input_schema: {
    type: "object",
    properties: {
      descriptions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: {
              type: "string",
              description:
                "2-3 sentences (<=400 chars) on the site's history or significance: when/why it was built or " +
                "founded, what happened there, or what it's known for. Do not mention hours, admission, " +
                "accessibility, phone numbers, or websites even if you found them. Ground the description in the " +
                "given tags and, when you looked it up, what you actually found. If you found nothing specific, " +
                "write a brief, honest sentence based on its category instead of guessing. Never invent dates, " +
                "facts, or designations you didn't find.",
            },
          },
          required: ["id", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["descriptions"],
    additionalProperties: false,
  },
};

// Server-side tool: Anthropic runs the actual search and feeds results back
// into the same request, so this worker never touches a search API or its
// credentials — it just has to allow the tool and, if needed, re-prompt the
// model to finalize afterward (see handleDescribe). No user_location hint —
// unlike muni_walk this app isn't tied to one city.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: MAX_WEB_SEARCHES_PER_DESCRIBE,
};

async function callAnthropic(env, { model, system, messages, tools, toolChoice, maxTokens }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 1024,
      system,
      messages,
      tools,
      tool_choice: toolChoice,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
  }

  return res.json();
}

// web_search results occasionally include page markup (e.g. <cite> citation
// tags) that the model copies verbatim into its generated text instead of
// treating as formatting to discard. Strip any HTML-like tags before the
// description reaches the client, since it's rendered as plain text.
function stripHtmlTags(text) {
  return String(text).replace(/<\/?[a-z][^>]*>/gi, "").trim();
}

function findToolUse(data, name) {
  return (data.content || []).find((b) => b.type === "tool_use" && b.name === name);
}

async function handleDescribe(env, body, corsHeaders) {
  const points = Array.isArray(body.points) ? body.points.slice(0, MAX_POINTS_PER_DESCRIBE) : [];
  if (!points.length) return jsonResponse({ descriptions: [] }, 200, corsHeaders);

  const pointsForModel = points.map((p) => ({
    id: String(p.id),
    name: p.name || null,
    tags: p.tags || {},
  }));

  const system =
    "You are a knowledgeable local historian writing entries for a walking-directions app. For each historical " +
    "site given (name + OpenStreetMap/National Register tags), decide whether you already know enough to write " +
    "something specific and interesting. If not — and it's a named, identifiable site rather than a generic " +
    "category — use the web_search tool to look it up (include its address or the surrounding city/region in the " +
    "query for accuracy). Write about its history and significance: when/why it was built or founded, what " +
    "happened there, or what it's known for. Leave out hours, admission, accessibility, phone numbers, and " +
    "websites even if you find them. Once you've looked into whatever you need to, call emit_descriptions " +
    "exactly once with one entry for every site given. Ground each description in what you found or in " +
    "well-established facts — never invent dates, events, or designations. Write plain prose only — never " +
    "include HTML or wiki markup (like <cite>, <ref>, or similar tags) even if a source you looked up displays " +
    "it that way.";
  const userText =
    `Historical sites (JSON):\n${JSON.stringify(pointsForModel)}\n\n` +
    `Look up whichever sites need it, then call emit_descriptions with one entry per id.`;

  const tools = [WEB_SEARCH_TOOL, DESCRIBE_TOOL];
  let messages = [{ role: "user", content: userText }];

  let data = await callAnthropic(env, {
    model: DESCRIBE_MODEL,
    system,
    messages,
    tools,
    toolChoice: { type: "auto" },
    maxTokens: 8192,
  });
  let toolUse = findToolUse(data, DESCRIBE_TOOL.name);

  // The model may stop after searching without finalizing — give it one
  // more turn, forced this time, with its own search results still in
  // context so it doesn't need to redo them.
  if (!toolUse && data.stop_reason !== "max_tokens") {
    messages = [
      ...messages,
      { role: "assistant", content: data.content },
      { role: "user", content: "Now call emit_descriptions with your final description for every site." },
    ];
    data = await callAnthropic(env, {
      model: DESCRIBE_MODEL,
      system,
      messages,
      tools,
      toolChoice: { type: "tool", name: DESCRIBE_TOOL.name },
      maxTokens: 4096,
    });
    toolUse = findToolUse(data, DESCRIBE_TOOL.name);
  }

  if (!toolUse) throw new Error("Model did not return the expected tool call");
  const descriptions = (toolUse.input.descriptions || []).map((d) => ({
    ...d,
    description: stripHtmlTags(d.description),
  }));
  return jsonResponse({ ...toolUse.input, descriptions }, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const originOk = !!origin && parseAllowedOrigins(env).includes(origin);

    if (request.method === "OPTIONS") {
      // Preflight: only hand back CORS headers (which is what lets the
      // browser proceed with the real request) for an allowed origin.
      return originOk ? new Response(null, { headers: corsHeadersFor(origin) }) : new Response(null, { status: 403 });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Use POST" }, 405, originOk ? corsHeadersFor(origin) : {});
    }
    // No CORS headers on a rejected origin: a browser from elsewhere can't
    // read this response anyway, and there's no reason to hand back
    // permissive headers to a non-browser caller either.
    if (!originOk) {
      return jsonResponse({ error: "Origin not allowed" }, 403, {});
    }
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: "Worker is missing the ANTHROPIC_API_KEY secret" }, 500, corsHeadersFor(origin));
    }
    if (!env.RATE_LIMIT_KV) {
      return jsonResponse({ error: "Worker is missing the RATE_LIMIT_KV binding" }, 500, corsHeadersFor(origin));
    }

    const rl = await checkAndIncrementRateLimit(env, request);
    if (!rl.ok) {
      return jsonResponse({ error: rl.reason }, 429, corsHeadersFor(origin));
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeadersFor(origin));
    }

    try {
      if (body.action === "describe") return await handleDescribe(env, body, corsHeadersFor(origin));
      return jsonResponse({ error: "Unknown action; expected 'describe'" }, 400, corsHeadersFor(origin));
    } catch (e) {
      return jsonResponse({ error: String((e && e.message) || e) }, 502, corsHeadersFor(origin));
    }
  },
};
