/**
 * Humanizer — a three-agent rewriting pipeline exposed as the `humanize` tool.
 *
 * Pass 1 (Voice Analyst) diagnoses machine-written patterns and lists the facts
 * that must survive. Pass 2 (Rewriter) restyles each section. Pass 3 (Editor)
 * reconciles every rewritten section against its source, restoring dropped
 * facts and removing leftover tells. The pipeline never invents content: the
 * editor is instructed to delete anything the rewriter added.
 *
 * The bundle imports no Harness package, so it installs as a plain directory.
 * @module @local/humanizer
 */

import { complete, resolveRoute } from './lib/complete.js'
import {
  clampBrief,
  draftRatioOk,
  joinSections,
  missingNumbers,
  parseEditorOutput,
  planSections,
  sampleForAnalysis,
  stripWrapper,
} from './lib/text.js'
import {
  ANALYST_SYSTEM,
  EDITOR_SYSTEM,
  INTENSITY_GUIDE,
  REWRITER_SYSTEM,
  TONE_GUIDE,
  buildAnalystInput,
  buildEditorInput,
  buildRewriterInput,
} from './lib/prompts.js'

/** Loader plugin name. */
export const name = 'humanize'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

/** Tone values the tool accepts. */
const TONES = ['match', 'academic', 'professional', 'casual', 'journalistic']

/** Intensity values the tool accepts. */
const INTENSITIES = ['light', 'balanced', 'strong']

/** Deployment defaults, overridable from the plugin row's `config`. */
const DEFAULTS = {
  provider: undefined,
  model: undefined,
  sectionChars: 6000,
  sampleChars: 18000,
  briefChars: 5000,
  maxInputChars: 200000,
  maxSections: 40,
  maxTokens: undefined,
  temperature: undefined,
}

const DESCRIPTION = 'Rewrite a document, assignment, or passage so it reads as human-written prose. '
  + 'Three passes run in order: an analyst collects the machine-written tells and the facts that must survive, '
  + 'a rewriter restyles each section, and an editor checks every rewrite against its source, restoring dropped facts '
  + 'and removing leftover tells. Prompts forbid invented content, and the result flags source figures that went missing '
  + 'or appeared out of nowhere; headings and the order of points are kept, while tables, code, and footnotes are '
  + 'carried through as plain text. Returns the final text plus what changed. It changes how the prose reads and cannot '
  + 'promise any AI detector\'s verdict — detectors also flag human text. Use it on existing text; supply the content '
  + 'with `text` or name a file with `path`. One analyst call runs, then two calls per section, so it is slow on long '
  + 'documents; up to 200,000 characters in up to 40 sections. `tone` and `intensity` set how far the rewrite may move.'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description: 'The full text to humanize. Omit when `path` names a file.',
    },
    path: {
      type: 'string',
      description: 'UTF-8 text or Markdown file to humanize; relative paths resolve against the session working directory. Omit when `text` is supplied.',
    },
    tone: {
      type: 'string',
      enum: [...TONES],
      description: 'Register to hold. `match` (default) keeps the source register.',
      default: 'match',
    },
    intensity: {
      type: 'string',
      enum: [...INTENSITIES],
      description: 'How much the rewrite may change. `light` fixes tells only, `balanced` rewrites sentences, `strong` may restructure paragraphs. Default `balanced`.',
      default: 'balanced',
    },
    notes: {
      type: 'string',
      description: 'Extra constraints the editor must respect, such as an audience, a word limit, or terms to keep verbatim.',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'route', 'sections', 'originalChars', 'finalChars', 'warnings', 'report'],
  properties: {
    text: { type: 'string', description: 'The humanized document.' },
    route: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    sections: { type: 'integer', description: 'How many sections the document was split into.' },
    originalChars: { type: 'integer' },
    finalChars: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    report: { type: 'array', items: { type: 'string' }, description: 'What the editor changed, one line each.' },
    sourcePath: { type: 'string', description: 'Resolved path of the file that was humanized, when a `path` was given.' },
  },
}

/**
 * Read and validate the plugin row's configuration.
 * @param {unknown} config - raw Loader config.
 * @returns {typeof DEFAULTS} resolved settings.
 */
export function normalizeSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS }
  const numbers = ['sectionChars', 'sampleChars', 'briefChars', 'maxInputChars', 'maxSections']
  for (const key of numbers) {
    const value = raw[key]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`humanize: config.${key} must be a positive integer`)
    }
    settings[key] = value
  }
  if (settings.sectionChars > 20000) throw new Error('humanize: config.sectionChars must not exceed 20000')
  if (settings.maxSections > 200) throw new Error('humanize: config.maxSections must not exceed 200')
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== 'string') throw new Error('humanize: config.provider must be a string')
    settings.provider = raw.provider
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string') throw new Error('humanize: config.model must be a string')
    settings.model = raw.model
  }
  if (raw.maxTokens !== undefined) {
    if (!Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0) throw new Error('humanize: config.maxTokens must be a positive integer')
    settings.maxTokens = raw.maxTokens
  }
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || raw.temperature < 0 || raw.temperature > 2) {
      throw new Error('humanize: config.temperature must be a number between 0 and 2')
    }
    settings.temperature = raw.temperature
  }
  return settings
}

/**
 * Validate the model-supplied arguments the parameter schema cannot enforce.
 * @param {unknown} args - raw tool arguments.
 * @returns {{ text?: string, path?: string, tone: string, intensity: string, notes?: string }} normalized arguments.
 */
export function normalizeArgs(args) {
  if (args === null || typeof args !== 'object') {
    throw new Error('humanize: arguments must be an object')
  }
  const raw = args
  const text = typeof raw.text === 'string' && raw.text.trim() !== '' ? raw.text : undefined
  const path = typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path.trim() : undefined
  if (text === undefined && path === undefined) {
    throw new Error('humanize: supply the content with `text`, or name a file with `path`')
  }
  if (text !== undefined && path !== undefined) {
    throw new Error('humanize: supply `text` or `path`, not both')
  }
  const tone = raw.tone ?? 'match'
  if (!TONES.includes(tone)) {
    throw new Error(`humanize: \`tone\` must be one of ${TONES.join(', ')}`)
  }
  const intensity = raw.intensity ?? 'balanced'
  if (!INTENSITIES.includes(intensity)) {
    throw new Error(`humanize: \`intensity\` must be one of ${INTENSITIES.join(', ')}`)
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    throw new Error('humanize: `notes` must be a string')
  }
  return { text, path, tone, intensity, notes: typeof raw.notes === 'string' && raw.notes.trim() !== '' ? raw.notes.trim() : undefined }
}

/**
 * Resolve the session working directory so a relative `path` behaves like every
 * other file path the agent uses.
 * @param {{ get: (name: string) => unknown }} services - Host service accessor.
 * @param {object} exec - tool execution context.
 * @returns {string | undefined} the directory, when the service provides one.
 */
function sessionDirectory(services, exec) {
  const workingDirectory = services.get('workingDirectory')
  const session = exec?.agent?.session
  if (workingDirectory === undefined || workingDirectory === null || session === undefined) return undefined
  try {
    return workingDirectory.get(session)
  } catch {
    return undefined
  }
}

/**
 * Read a document through the Host filesystem service, which honors its target
 * resolution and text-decoding rules.
 * @param {{ get: (name: string) => unknown }} services - Host service accessor.
 * @param {object} exec - tool execution context.
 * @param {string} path - path supplied by the model.
 * @returns {Promise<{ source: string, displayPath: string }>} the document text and its resolved path.
 */
async function readDocument(services, exec, path) {
  const fs = services.get('fs')
  if (fs === undefined || fs === null) {
    throw new Error('humanize: this profile has no filesystem service; pass the content with `text` instead of `path`')
  }
  const cwd = sessionDirectory(services, exec)
  const target = await fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
  const info = await fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new Error(`humanize: no file at ${target.displayPath}`)
  }
  if (info.type !== 'file') {
    throw new Error(`humanize: ${target.displayPath} is a ${info.type}, not a regular file`)
  }
  const source = await fs.readText(target, exec.signal)
  return { source, displayPath: target.displayPath }
}

/**
 * Run the three-agent pipeline over one document.
 * @param {{ get: (name: string) => unknown }} services - Host service accessor.
 * @param {object} request - pipeline request.
 * @param {string} request.source - document text.
 * @param {'match'|'academic'|'professional'|'casual'|'journalistic'} request.tone - register to hold.
 * @param {'light'|'balanced'|'strong'} request.intensity - rewrite latitude.
 * @param {string} [request.notes] - caller constraints.
 * @param {AbortSignal} request.signal - caller cancellation.
 * @returns {Promise<object>} the canonical tool value.
 */
async function runPipeline(services, request) {
  const settings = request.settings
  const signal = request.signal
  const source = request.source
  const warnings = []
  const report = []

  if (source.trim() === '') throw new Error('humanize: the document is empty')
  if (source.length > settings.maxInputChars) {
    throw new Error(`humanize: the document is ${source.length} characters, above the ${settings.maxInputChars} limit; split it and humanize the parts`)
  }

  const route = resolveRoute(services, settings)
  const plan = planSections(source, settings.sectionChars)
  if (plan.sections.length > settings.maxSections) {
    throw new Error(`humanize: the document needs ${plan.sections.length} sections, above the ${settings.maxSections} limit; raise config.maxSections or split the document`)
  }

  const tone = TONE_GUIDE[request.tone] ?? TONE_GUIDE.match
  const intensity = INTENSITY_GUIDE[request.intensity] ?? INTENSITY_GUIDE.balanced
  const call = (system, input) => complete(services, {
    route,
    system,
    input,
    signal,
    ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
    ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
  })

  // Pass 1 — Voice Analyst: one brief for the whole document.
  const sample = sampleForAnalysis(source, settings.sampleChars)
  if (sample.sampled) {
    warnings.push(`the analyst read a ${settings.sampleChars}-character sample of the ${source.length}-character document, not all of it`)
  }
  signal.throwIfAborted()
  const analysis = await call(ANALYST_SYSTEM, buildAnalystInput(sample))
  if (analysis.truncated) warnings.push('the analyst reply hit the output token limit; the brief may be incomplete')
  const constraints = request.notes === undefined ? '' : `\nCALLER CONSTRAINTS (always honor)\n${request.notes}`
  const brief = clampBrief(`${stripWrapper(analysis.text)}${constraints}`, settings.briefChars)

  // Passes 2 and 3 — Rewriter then Editor, one section at a time. A section that
  // fails keeps its original text instead of discarding the sections already done.
  const finals = []
  let rejectedDrafts = 0
  let failedSections = 0
  for (let index = 0; index < plan.sections.length; index++) {
    signal.throwIfAborted()
    const section = plan.sections[index]
    const previous = index > 0 ? finals[index - 1]?.slice(-400) : undefined
    const next = index + 1 < plan.sections.length ? plan.sections[index + 1].text.slice(0, 300) : undefined

    try {
      const rewritten = await call(REWRITER_SYSTEM, buildRewriterInput({
        brief,
        text: section.text,
        before: previous,
        after: next,
        tone,
        intensity,
        index: index + 1,
        total: plan.sections.length,
      }))
      if (rewritten.truncated) warnings.push(`section ${index + 1}: the rewrite hit the output token limit`)

      let draft = stripWrapper(rewritten.text)
      const verdict = draftRatioOk(draft, section.text)
      if (!verdict.ok) {
        rejectedDrafts += 1
        warnings.push(`section ${index + 1}: the rewrite was ${Math.round(verdict.ratio * 100)}% of its source length, so the original was kept and only edited`)
        draft = section.text
      }

      const edited = await call(EDITOR_SYSTEM, buildEditorInput({ brief, source: section.text, draft, intensity }))
      if (edited.truncated) warnings.push(`section ${index + 1}: the editor hit the output token limit`)

      const parsed = parseEditorOutput(edited.text)
      if (!parsed.usedMarker) {
        warnings.push(`section ${index + 1}: the editor reply ignored the requested output markers; its text was used as-is`)
      } else if (!parsed.parsed) {
        warnings.push(`section ${index + 1}: the editor reply omitted its change report`)
      }
      let finalText = parsed.final.trim()
      if (finalText === '') {
        warnings.push(`section ${index + 1}: the editor returned no final text, so the draft was used`)
        finalText = draft
      }
      if (draftRatioOk(finalText, section.text, 0.35).ok === false) {
        warnings.push(`section ${index + 1}: the final text is much shorter than its source; check for lost content`)
      }
      for (const line of parsed.report) {
        if (!report.includes(line)) report.push(line)
      }
      finals.push(finalText)
    } catch (error) {
      if (signal.aborted) throw error
      failedSections += 1
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(`section ${index + 1}: the model call failed (${reason}); the original text was kept`)
      finals.push(section.text)
    }
  }

  const text = joinSections(finals, plan.sections)
  if (text.trim() === '') throw new Error('humanize: the pipeline produced no text')
  if (rejectedDrafts > 0) warnings.push(`${rejectedDrafts} section(s) fell back to the original text`)
  if (failedSections > 0) warnings.push(`${failedSections} section(s) could not be rewritten and stay as they were`)

  const drift = (text.length - source.length) / source.length
  if (Math.abs(drift) > 0.25) {
    warnings.push(`the final text is ${Math.abs(Math.round(drift * 100))}% ${drift < 0 ? 'shorter' : 'longer'} than the source; check that nothing was cut or padded`)
  }

  const lost = missingNumbers(source, text)
  if (lost.length > 0) warnings.push(`figures in the source that no longer appear verbatim: ${lost.join(', ')}`)
  const added = missingNumbers(text, source)
  if (added.length > 0) warnings.push(`figures in the final text that do not appear in the source: ${added.join(', ')}`)

  const maxWarnings = 24
  const maxReport = 30
  const shownWarnings = warnings.slice(0, maxWarnings)
  if (warnings.length > maxWarnings) shownWarnings.push(`${warnings.length - maxWarnings} more warning(s) omitted`)
  const shownReport = report.slice(0, maxReport)
  if (report.length > maxReport) shownReport.push(`${report.length - maxReport} more change(s) omitted`)

  return {
    text,
    route: { provider: route.provider, model: route.model },
    sections: plan.sections.length,
    originalChars: source.length,
    finalChars: text.length,
    warnings: shownWarnings,
    report: shownReport,
    ...request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath },
  }
}

/**
 * Render the canonical value for the model.
 * @param {unknown} _args - validated arguments (unused).
 * @param {object} value - canonical tool value.
 * @returns {{ type: 'text', text: string }[]} model-facing content.
 */
function renderResult(_args, value) {
  const origin = value.sourcePath === undefined
    ? ''
    : ` Source: ${value.sourcePath} (read only; that file was not modified).`
  const head = `Humanized ${value.originalChars} → ${value.finalChars} chars across ${value.sections} section(s) `
    + `on ${value.route.provider}/${value.route.model}.${origin}`
  const report = value.report.length === 0
    ? ''
    : `\n\nWhat changed (reported by the editor):\n${value.report.map(line => `- ${line}`).join('\n')}`
  const warnings = value.warnings.length === 0
    ? ''
    : `\n\nWarnings:\n${value.warnings.map(line => `- ${line}`).join('\n')}`
  return [{ type: 'text', text: `${head}${report}${warnings}\n\n=== HUMANIZED TEXT ===\n${value.text}` }]
}

/**
 * Build the `humanize` tool definition.
 * @param {object} services - Host service accessor.
 * @param {object} settings - resolved plugin configuration.
 * @returns {object} a registry-ready tool definition.
 */
function createTool(services, settings) {
  return {
    name: 'humanize',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const input = normalizeArgs(args)
      let source = input.text
      let sourcePath
      if (source === undefined) {
        const document = await readDocument(services, exec, input.path)
        source = document.source
        sourcePath = document.displayPath
      }
      return runPipeline(services, {
        source,
        settings,
        tone: input.tone,
        intensity: input.intensity,
        notes: input.notes,
        signal: exec.signal,
        ...sourcePath === undefined ? {} : { sourcePath },
      })
    },
  }
}

/**
 * Register the tool for the lifetime of the plugin.
 * @param {object} ctx - Cordis context.
 * @param {unknown} config - the plugin row's configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const services = { get: serviceName => ctx.get(serviceName) }
  const tool = createTool(services, settings)
  ctx.effect(() => ctx.tools.register(tool))
}
