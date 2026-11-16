/**
 * One-shot model completion over the Host `llm` service. Used by all three
 * pipeline agents: the plugin owns the prompt and the interpretation, this
 * module owns route preparation, streaming, assembly, and failure mapping.
 *
 * No Harness package is imported here on purpose, so the bundle installs as a
 * plain directory with no dependency resolution of its own.
 * @module humanizer/lib/complete
 */

/**
 * Resolve the model route for one pipeline run.
 * @param {object} services - `{ get(name) }` accessor for Host services.
 * @param {{ provider?: string, model?: string }} config - configured route overrides.
 * @returns {{ provider: string, model: string, reasoningEffort?: string }} the route.
 * @throws {Error} when neither the configuration nor the default model provides one.
 */
export function resolveRoute(services, config) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('humanize: configure both `provider` and `model`, or neither')
  }
  const fallback = services.get('agentDefaultModel')
  const selection = fallback?.currentSelection?.()
  if (selection === undefined || selection === null || !selection.provider || !selection.model) {
    throw new Error('humanize: no model route is available; set the plugin row\'s `provider` and `model`, or choose a default model')
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * Build one user message in the request shape the LLM service accepts.
 * @param {string} text - user message text.
 * @returns {{ role: 'user', content: { type: 'text', text: string }[] }} the message.
 */
export function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * Run one completion and assemble its text.
 * @param {object} services - `{ get(name) }` accessor for Host services.
 * @param {object} options - call options.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} options.route - model route.
 * @param {string} options.system - system prompt.
 * @param {string} options.input - user message text.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.maxTokens] - explicit output cap.
 * @param {number} [options.temperature] - sampling temperature, when the model accepts one.
 * @returns {Promise<{ text: string, finish: string | undefined, truncated: boolean }>} assembled text and terminal state.
 * @throws {Error} when the LLM service is unavailable, preparation fails, the model reports an error, or the reply is empty.
 */
export async function complete(services, options) {
  const llm = services.get('llm')
  if (llm === undefined || llm === null) {
    throw new Error('humanize: the LLM service is not available in this profile')
  }

  const { route, system, input, signal, maxTokens, temperature } = options
  const controls = {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    ...maxTokens === undefined ? {} : { maxTokens },
  }

  let call
  try {
    call = await llm.prepareCall(controls, signal)
  } catch (error) {
    throw new Error(`humanize: cannot prepare the ${route.provider}/${route.model} request: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  const request = {
    ...call.config,
    messages: [userMessage(input)],
    system,
    ...temperature === undefined ? {} : { temperature },
    ...signal === undefined ? {} : { signal },
  }

  const deltas = []
  const blocks = []
  let finish
  for await (const chunk of call.stream(request)) {
    switch (chunk?.type) {
      case 'text-delta':
        deltas.push(chunk.text)
        break
      case 'block-end':
        if (chunk.block?.type === 'text') blocks.push(chunk.block.text)
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }

  const kind = typeof finish === 'object' && finish !== null ? finish.kind : undefined
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish.failure ?? {}
    throw new Error(`humanize: the model call ended with ${kind}: ${failure.message ?? 'unknown failure'}`)
  }

  const text = deltas.length > 0 ? deltas.join('') : blocks.join('')
  if (text.trim() === '') {
    throw new Error(`humanize: the model returned no text${kind === undefined ? '' : ` (finish: ${kind})`}`)
  }

  return { text, finish: kind, truncated: kind === 'max-tokens' }
}
