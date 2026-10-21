'use strict';
// OpenAI Responses boundary for the Sol and Shared Info plans (same { complete({ system, messages, signal }), model } shape as the Claude
// provider in server.js). Fixed HTTPS endpoint, fixed model, reasoning effort low, store true. `store: true` is the owner's standing
// response-retention preference; it is NOT a training-sharing switch (that is a property of the OpenAI project, see docs/billing.md).
// One request per call: no retry, no fallback to another model/key/project. The response body, prompts and keys are never logged or forwarded;
// every failure surfaces as a ProviderError carrying only an HTTP-ish status.
const ENDPOINT = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-6.1-sol';
const EFFORT = 'low';
// Reasoning tokens count toward this cap, so it is higher than the Claude output cap; still a hard bound.
const MAX_OUTPUT_TOKENS = 4000;

class ProviderError extends Error {
  constructor(status) { super('provider error'); this.name = 'ProviderError'; this.status = status; }
}

const textOfBlocks = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '');

// Anthropic-shaped system blocks / messages (what lib/coaching.js builds) -> Responses `instructions` / `input`.
function toInput(messages) {
  return messages.map(m => {
    if (m.role === 'assistant') return { role: 'assistant', content: textOfBlocks(m.content) };
    if (typeof m.content === 'string') return { role: 'user', content: m.content };
    const parts = [];
    for (const b of m.content || []) {
      if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
      else if (b.type === 'image' && b.source && b.source.type === 'base64') parts.push({ type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      else if (b.type === 'document' && b.source && b.source.type === 'base64') parts.push({ type: 'input_file', filename: 'document.pdf', file_data: `data:${b.source.media_type};base64,${b.source.data}` });
      else throw new ProviderError(400);
    }
    return { role: 'user', content: parts };
  });
}

// Responses output -> existing text-block shape. Anything that is not a complete answer with text is an error (a partial/refused/failed reply is never stored).
function parseOutput(data) {
  if (!data || typeof data !== 'object' || data.error || data.status === 'failed' || data.status === 'cancelled') throw new ProviderError(502);
  if (data.status !== undefined && data.status !== 'completed') throw new ProviderError(502); // incomplete (e.g. output cap hit) or in progress
  if (!Array.isArray(data.output)) throw new ProviderError(502);
  const texts = [];
  for (const item of data.output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && part.type === 'refusal') throw new ProviderError(502);
      if (part && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  const text = texts.join('\n');
  if (!text.trim()) throw new ProviderError(502);
  return [{ type: 'text', text }];
}

function createOpenAiProvider({ apiKey, projectId, fetchImpl }) {
  if (!apiKey || !projectId) throw new Error('openai provider needs its own key and project');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  return {
    model: MODEL, // recorded with each stored reply
    async complete({ system, messages, signal }) {
      const instructions = (Array.isArray(system) ? system : [{ text: system }]).map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n\n');
      const body = JSON.stringify({ model: MODEL, instructions, input: toInput(messages), reasoning: { effort: EFFORT }, store: true, max_output_tokens: MAX_OUTPUT_TOKENS });
      let response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'OpenAI-Project': projectId },
          body,
          signal
        });
      } catch (_) {
        throw new ProviderError(0); // network failure or abort/timeout
      }
      if (!response.ok) throw new ProviderError(response.status);
      const data = await response.json().catch(() => null);
      return parseOutput(data);
    }
  };
}

module.exports = { createOpenAiProvider, ProviderError, ENDPOINT, MODEL, EFFORT, MAX_OUTPUT_TOKENS };
