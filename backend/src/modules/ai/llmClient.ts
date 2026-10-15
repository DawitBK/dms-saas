/**
 * Vendor-neutral LLM client — every AI feature in this module (chat assistant,
 * document summarization, metadata extraction) goes through this one file
 * instead of importing a provider SDK directly. Whoever operates this
 * deployment can point it at whichever provider they have a key for, without
 * touching the feature code in ai.routes.ts or AIWorker.ts.
 *
 * Supported providers, auto-detected from env vars (first match wins unless
 * AI_PROVIDER forces one):
 *   - groq       GROQ_API_KEY        (OpenAI-compatible; api.groq.com)
 *   - openai     OPENAI_API_KEY      (OpenAI-compatible; api.openai.com, or
 *                                     OPENAI_BASE_URL for an Azure/proxy front)
 *   - custom     AI_BASE_URL + AI_API_KEY
 *                                    (any other OpenAI-compatible endpoint —
 *                                     OpenRouter, Together, Fireworks, a local
 *                                     Ollama/vLLM server, etc.)
 *   - anthropic  AI_API_KEY or ANTHROPIC_API_KEY
 *                                    (native Messages API, only reached when
 *                                     no AI_BASE_URL is set — see resolveProvider)
 *
 * Per-provider model override: GROQ_MODEL / OPENAI_MODEL / AI_MODEL / ANTHROPIC_MODEL.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../../core/AppError.js';
import { config } from '../../config/env.js';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmChatMessage {
  role: LlmRole;
  /** Empty string/undefined is valid for an assistant message that is pure tool_calls. */
  content?: string | null;
  /** Set on assistant messages that requested tool calls, so history replays correctly. */
  toolCalls?: LlmToolCall[];
  /** Set on role:'tool' messages — must match the LlmToolCall.id it answers. */
  toolCallId?: string;
  /** Only meaningful on a 'user' message — one or more images to attach
   *  alongside `content`. Requires a vision-capable model on whichever
   *  provider is active (see resolveProvider below); a provider/model that
   *  doesn't support image input will surface the provider's own rejection
   *  as ERR-AI-PROVIDER rather than something silently misinterpreting it. */
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (OpenAI calls this "parameters", Anthropic "input_schema" — same shape). */
  parameters: Record<string, unknown>;
}

export interface LlmChatResult {
  text: string;
  toolCalls: LlmToolCall[];
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; raw?: unknown };
}

type ProviderName = 'groq' | 'openai' | 'anthropic' | 'custom';

interface ProviderConfig {
  provider: ProviderName;
  apiKey: string;
  model: string;
  /** The model used for image-input calls (llmExtractStructured) — see the
   *  GROQ_VISION_MODEL/etc. config comments for why every provider gets its
   *  own override instead of one provider being hardcoded as "the" vision
   *  backend. Falls back to `model` for a provider with no dedicated vision
   *  override (today: groq, custom) — an honest reproduction of "this
   *  provider's configured model may not support images", not a guess at
   *  one that does. */
  visionModel: string;
  /** OpenAI-compatible providers only — Anthropic uses the SDK directly. */
  baseUrl?: string;
}

function groqConfig(): ProviderConfig | null {
  const apiKey = config.GROQ_API_KEY;
  if (!apiKey) return null;
  return {
    provider: 'groq',
    apiKey,
    // gpt-oss's native tool-calling is far more reliable on Groq than the
    // Llama models, which intermittently emit non-JSON <function=...> text
    // instead of a real tool_calls entry (Groq then rejects the request
    // outright with a 400 tool_use_failed).
    model: config.GROQ_MODEL,
    visionModel: config.GROQ_VISION_MODEL ?? config.GROQ_MODEL,
    baseUrl: 'https://api.groq.com/openai/v1',
  };
}

function openaiConfig(): ProviderConfig | null {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    provider: 'openai',
    apiKey,
    model: config.OPENAI_MODEL,
    visionModel: config.OPENAI_VISION_MODEL,
    baseUrl: config.OPENAI_BASE_URL,
  };
}

function customConfig(): ProviderConfig | null {
  // Requires BOTH — AI_BASE_URL alone is ambiguous, and AI_API_KEY alone is
  // claimed by the Anthropic fallback below (native API, no base URL to set).
  const baseUrl = config.AI_BASE_URL;
  const apiKey = config.AI_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { provider: 'custom', apiKey, model: config.AI_MODEL, visionModel: config.AI_VISION_MODEL ?? config.AI_MODEL, baseUrl };
}

function anthropicConfig(): ProviderConfig | null {
  const apiKey = config.AI_API_KEY ?? config.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { provider: 'anthropic', apiKey, model: config.ANTHROPIC_MODEL, visionModel: config.ANTHROPIC_VISION_MODEL };
}

const RESOLVERS: Record<ProviderName, () => ProviderConfig | null> = {
  groq: groqConfig,
  openai: openaiConfig,
  custom: customConfig,
  anthropic: anthropicConfig,
};

function resolveProvider(): ProviderConfig | null {
  const explicit = config.AI_PROVIDER?.toLowerCase() as ProviderName | undefined;
  if (explicit) {
    if (!(explicit in RESOLVERS)) {
      throw new AppError(500, 'ERR-CONFIG-INVALID', `AI_PROVIDER="${explicit}" is not one of: groq, openai, anthropic, custom`);
    }
    return RESOLVERS[explicit]();
  }
  // custom is checked before the bare-AI_API_KEY anthropic fallback: AI_BASE_URL
  // being set is an unambiguous "point this somewhere else" signal, whereas
  // AI_API_KEY alone (no base URL) has always meant "Anthropic" in this codebase.
  return groqConfig() ?? openaiConfig() ?? customConfig() ?? anthropicConfig();
}

export function isAiConfigured(): boolean {
  return resolveProvider() !== null;
}

export function getLlmProviderInfo(): { provider: ProviderName; model: string; visionModel: string } | null {
  const cfg = resolveProvider();
  return cfg ? { provider: cfg.provider, model: cfg.model, visionModel: cfg.visionModel } : null;
}

function requireProvider(): ProviderConfig {
  const cfg = resolveProvider();
  if (!cfg) {
    throw new AppError(
      503,
      'ERR-AI-UNAVAILABLE',
      'No AI provider configured — set GROQ_API_KEY, OPENAI_API_KEY, AI_API_KEY/ANTHROPIC_API_KEY, or AI_BASE_URL+AI_API_KEY',
    );
  }
  return cfg;
}

function safeJsonParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── OpenAI-compatible branch (groq | openai | custom) ────────────────────────

function toOpenAiMessages(system: string | undefined, messages: LlmChatMessage[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
    } else if (m.images?.length) {
      // OpenAI-style multipart content: a text part plus one image_url part
      // per attached image, data-URL-encoded (no separate file upload step
      // needed — this is the same shape both gpt-4o-mini and any other
      // OpenAI-compatible vision model expect).
      out.push({
        role: m.role,
        content: [
          { type: 'text', text: m.content ?? '' },
          ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content ?? '' });
    }
  }
  return out;
}

async function openAiCompatibleChat(
  cfg: ProviderConfig,
  opts: { system?: string; messages: LlmChatMessage[]; tools?: LlmToolDef[]; maxTokens?: number; forceTool?: string; useVisionModel?: boolean },
): Promise<LlmChatResult> {
  const body: Record<string, unknown> = {
    model: opts.useVisionModel ? cfg.visionModel : cfg.model,
    messages: toOpenAiMessages(opts.system, opts.messages),
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    // forceTool: compels the model to call this specific tool rather than
    // possibly replying with plain text instead — 'auto' (the previous,
    // still-default behaviour for every other caller) leaves that choice to
    // the model, which is fine for the chat assistant's own multi-tool loop
    // but not for a single-purpose "always return this exact shape" caller.
    body.tool_choice = opts.forceTool ? { type: 'function', function: { name: opts.forceTool } } : 'auto';
  }

  // Some OpenAI-compatible models on Groq (Llama/Qwen family — see this
  // function's forceTool comment above) intermittently emit their tool call
  // as raw <function=...> pseudo-XML text instead of a real tool_calls
  // entry; Groq's API then rejects the WHOLE request with a 400
  // "tool_use_failed" rather than returning the malformed text for us to
  // recover from. Confirmed live 2026-09-19 against qwen/qwen3.8-27b (the
  // form-extraction vision model): the same image, same prompt, same
  // request succeeded on one attempt and failed this way on the next two —
  // it's model nondeterminism, not a bad request, so a short retry recovers
  // it far more often than it fails a second time. Only retried when
  // forceTool is actually set: that's the only case this failure mode can
  // occur (a caller with tools left on 'auto' just gets a plain-text reply
  // instead, which is a valid response, not an error).
  const MAX_TOOL_USE_ATTEMPTS = 3;
  let res!: Response;
  let errBody = '';
  for (let attempt = 1; attempt <= MAX_TOOL_USE_ATTEMPTS; attempt++) {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    errBody = await res.text().catch(() => '');
    let errorCode: unknown;
    try {
      errorCode = JSON.parse(errBody)?.error?.code;
    } catch {
      errorCode = undefined;
    }
    const isRetryableToolUseFailure = Boolean(opts.forceTool) && errorCode === 'tool_use_failed';
    if (!isRetryableToolUseFailure || attempt === MAX_TOOL_USE_ATTEMPTS) {
      throw new AppError(502, 'ERR-AI-PROVIDER', `${cfg.provider} API error (${res.status}): ${errBody.slice(0, 500)}`);
    }
  }

  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name,
    arguments: safeJsonParse(tc.function?.arguments),
  }));

  return {
    text: msg.content ?? '',
    toolCalls,
    model: json.model,
    usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens, raw: json.usage },
  };
}

// ─── Anthropic branch (native Messages API) ───────────────────────────────────

// Anthropic's media_type only accepts these four raster types — anything
// else (e.g. an unusual PDF-rasterization output) must already have been
// normalized (sharp .png()) before it ever reaches here.
type AnthropicImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

function toAnthropicMessages(messages: LlmChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // Anthropic takes system as a top-level param
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId!, content: m.content ?? '' }] });
    } else if (m.images?.length) {
      const content: Anthropic.ContentBlockParam[] = [
        ...m.images.map((img): Anthropic.ContentBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType as AnthropicImageMediaType, data: img.base64 },
        })),
        { type: 'text', text: m.content ?? '' },
      ];
      out.push({ role: m.role as 'user' | 'assistant', content });
    } else {
      out.push({ role: m.role as 'user' | 'assistant', content: m.content ?? '' });
    }
  }
  return out;
}

async function anthropicChat(
  cfg: ProviderConfig,
  opts: { system?: string; messages: LlmChatMessage[]; tools?: LlmToolDef[]; maxTokens?: number; forceTool?: string; useVisionModel?: boolean },
): Promise<LlmChatResult> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const tools: Anthropic.Tool[] | undefined = opts.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));

  const response = await client.messages.create({
    model: opts.useVisionModel ? cfg.visionModel : cfg.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    tools,
    // forceTool mirrors the OpenAI branch's tool_choice override — see its
    // comment for why the chat assistant's own multi-tool loop still wants
    // Anthropic's default 'auto' behaviour (no tool_choice set at all).
    tool_choice: opts.forceTool ? { type: 'tool', name: opts.forceTool } : undefined,
    messages: toAnthropicMessages(opts.messages),
  });

  const toolCalls: LlmToolCall[] = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return {
    text,
    toolCalls,
    model: response.model,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, raw: response.usage },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * One provider-agnostic chat turn. Callers that need tools own the agentic
 * loop themselves (call this, execute any returned toolCalls, append the
 * results as role:'tool' messages, call again) — tool execution is
 * app-specific (DB queries here), so it doesn't belong inside this client.
 */
export async function llmChat(opts: {
  system?: string;
  messages: LlmChatMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  /** Compels the model to call this exact tool instead of possibly replying
   *  with plain text — see llmExtractStructured, the one caller that needs
   *  this; every existing caller (the chat assistant's own multi-tool loop)
   *  omits it and keeps the previous 'auto' behaviour unchanged. */
  forceTool?: string;
  /** Uses whichever provider is active's VISION model override instead of
   *  its plain chat model — see the ProviderConfig.visionModel comment. */
  useVisionModel?: boolean;
}): Promise<LlmChatResult> {
  const cfg = requireProvider();
  return cfg.provider === 'anthropic' ? anthropicChat(cfg, opts) : openAiCompatibleChat(cfg, opts);
}

/** Convenience wrapper for the common no-tools, single-prompt case (summarization, extraction). */
export async function llmComplete(prompt: string, maxTokens = 512): Promise<{ text: string; model?: string; usage?: LlmChatResult['usage'] }> {
  const result = await llmChat({ messages: [{ role: 'user', content: prompt }], maxTokens });
  return { text: result.text, model: result.model, usage: result.usage };
}

/**
 * One image + instructions in, one guaranteed structured object out (or a
 * thrown ERR-AI-EXTRACTION-FAILED) — the shape every "read this
 * picture/PDF and give me back JSON matching this schema" feature needs
 * (today: the form-builder's "build from a photo or PDF").
 *
 * Unlike llmChat's other callers (the compliance chat assistant, which picks
 * from several tools across a multi-turn loop and must be free to reply in
 * plain text instead), this is single-purpose: there is exactly one tool,
 * and a reply that ISN'T that tool call is a failure, not a valid outcome.
 * `forceTool` (both provider branches, above) is what makes that guarantee
 * real rather than "the model usually complies."
 *
 * Requires a vision-capable model on whichever provider is active — set
 * ANTHROPIC_API_KEY (claude-sonnet-4-6, the coded default, reads images
 * natively) or OPENAI_API_KEY (gpt-4o-mini, also the coded default) if the
 * currently-configured provider doesn't support image input. A
 * non-vision-capable provider's rejection of the image content surfaces as
 * the existing ERR-AI-PROVIDER (502), same as any other provider-side error
 * this client already surfaces — not specially detected here, since which
 * models support vision changes over time and isn't this client's job to
 * hardcode.
 */
export async function llmExtractStructured(opts: {
  system: string;
  prompt: string;
  images: Array<{ mimeType: string; base64: string }>;
  tool: LlmToolDef;
  maxTokens?: number;
}): Promise<Record<string, unknown>> {
  const result = await llmChat({
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt, images: opts.images }],
    tools: [opts.tool],
    forceTool: opts.tool.name,
    useVisionModel: true,
    maxTokens: opts.maxTokens ?? 4096,
  });
  const call = result.toolCalls.find((tc) => tc.name === opts.tool.name);
  if (!call) {
    if (result.text) {
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          // ignore
        }
      }
    }
    throw new AppError(
      502,
      'ERR-AI-EXTRACTION-FAILED',
      'The AI model did not return the expected structured result — try again, or with a clearer image.',
    );
  }
  return call.arguments;
}
