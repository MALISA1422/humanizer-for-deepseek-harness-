/**
 * Pipeline test harness. Runs the real plugin (index.js, lib/*) against a
 * scripted stand-in for the Host `llm` service, so section planning, prompt
 * assembly, output parsing, fallbacks, and cancellation are exercised without a
 * model call. Run with: node test/pipeline.test.js
 */

import { apply, name as pluginName, inject, normalizeArgs, normalizeSettings } from '../index.js'
import {
  draftRatioOk,
  joinSections,
  missingNumbers,
  parseEditorOutput,
  planSections,
  sampleForAnalysis,
  splitIntoBlocks,
  stripWrapper,
} from '../lib/text.js'

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks += 1
  const ok = actual === expected
  if (!ok) {
    failures += 1
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function ok(label, value) {
  checks += 1
  if (!value) {
    failures += 1
    console.error(`FAIL ${label}`)
  }
}

function deepEqual(label, actual, expected) {
  check(label, JSON.stringify(actual), JSON.stringify(expected))
}

/* ------------------------------------------------------------------ */
/* Scripted Host services                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a fake context that records the registered tool and serves stubs for
 * `agentDefaultModel`, `llm`, and optionally `fs`.
 */
function createHarness(options = {}) {
  const state = {
    tool: undefined,
    calls: [],
    sources: [],
    streamed: 0,
  }

  const responder = options.responder ?? (() => 'ok')

  const services = {
    agentDefaultModel: {
      currentSelection: () => (Object.hasOwn(options, 'selection')
        ? options.selection
        : { provider: 'stub-provider', model: 'stub-model' }),
    },
    llm: {
      async prepareCall(config) {
        state.calls.push({ phase: 'prepare', config })
        return {
          config,
          stream: request => {
            state.streamed += 1
            const system = String(request.system ?? '')
            let role = 'unknown'
            if (system.includes('Voice Analyst')) role = 'analyst'
            else if (system.includes('Rewriter, the second')) role = 'rewriter'
            else if (system.includes('Editor, the last')) role = 'editor'
            const input = request.messages?.[0]?.content?.[0]?.text ?? ''
            state.sources.push({ role, input })
            const text = responder({ role, input, request })
            const chunks = [
              { type: 'block-start', index: 0, blockType: 'text' },
              ...String(text).match(/[\s\S]{1,40}/g).map(part => ({ type: 'text-delta', index: 0, text: part })),
              { type: 'finish', reason: { kind: options.finish ?? 'stop' } },
            ]
            return (async function* () { for (const chunk of chunks) yield chunk })()
          },
        }
      },
    },
  }
  if (options.fs !== undefined) services.fs = options.fs

  const ctx = {
    effect(fn) { fn(); return () => {} },
    tools: { register(definition) { state.tool = definition; return () => {} } },
    get(serviceName) { return services[serviceName] },
  }
  return { ctx, state, services }
}

/** Extract the `<<<SECTION ... SECTION>>>` body from a rewriter prompt. */
function sectionOf(input) {
  const match = /<<<SECTION\n([\s\S]*?)\nSECTION>>>/.exec(input)
  return match === null ? '' : match[1]
}

/** Extract the `<<<DRAFT ... DRAFT>>>` body from an editor prompt. */
function draftOf(input) {
  const match = /<<<DRAFT\n([\s\S]*?)\nDRAFT>>>/.exec(input)
  return match === null ? '' : match[1]
}

/** A default responder that behaves like a competent three-agent run. */
function scriptedResponder(hooks = {}) {
  return ({ role, input }) => {
    if (role === 'analyst') return hooks.analyst ?? 'REGISTER\nFormal report.'
    if (role === 'rewriter') {
      const section = sectionOf(input)
      if (hooks.rewriter !== undefined) return hooks.rewriter(section, input)
      return `Rewritten: ${section}`
    }
    const draft = draftOf(input)
    if (hooks.editor !== undefined) return hooks.editor(draft, input)
    return `=== FINAL ===\n${draft}\n=== REPORT ===\n- tightened the opening`
  }
}

const SAMPLE_DOC = [
  '# Quarterly logistics review',
  '',
  'The logistics function has undertaken a comprehensive review of its operations. It is important to note that the results are robust, scalable, and seamless. Furthermore, the team leveraged cross-functional synergy to foster alignment.',
  '',
  'In conclusion, the logistics function has undertaken a comprehensive review of its operations and will continue to do so.',
].join('\n')

const LONG_DOC = Array.from({ length: 6 }, (_, index) =>
  `Paragraph ${index + 1}. ${'The vendor reported steady throughput across the quarter. '.repeat(18)}`).join('\n\n')

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

{
  const { blocks, separator } = splitIntoBlocks(SAMPLE_DOC)
  check('splitIntoBlocks separator', separator, '\n\n')
  check('splitIntoBlocks block count', blocks.length, 3)
  ok('splitIntoBlocks keeps heading', blocks[0].startsWith('# Quarterly'))

  const plan = planSections(SAMPLE_DOC, 6000)
  check('single section for small doc', plan.sections.length, 1)
  check('round trip small doc', joinSections(plan.sections.map(s => s.text), plan.sections), SAMPLE_DOC.trim())
}

{
  const plan = planSections(LONG_DOC, 1500)
  ok('long doc splits into several sections', plan.sections.length > 1)
  const rebuilt = joinSections(plan.sections.map(s => s.text), plan.sections)
  check('round trip long doc', rebuilt, LONG_DOC.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim())
  let total = 0
  for (const section of plan.sections) total += section.text.length
  ok('sections are not over budget by much', total <= LONG_DOC.length + 40)
}

{
  const headingDoc = '# Title\n\n' + 'Body sentence here. '.repeat(120)
  const plan = planSections(headingDoc, 500)
  ok('heading always opens a section', plan.sections[0].text.startsWith('# Title'))
  ok('second section continues the body', plan.sections.length > 1)
}

{
  check('stripWrapper removes fences', stripWrapper('```text\nhello\n```'), 'hello')
  check('stripWrapper removes FINAL marker', stripWrapper('=== FINAL ===\nhello'), 'hello')
  check('stripWrapper removes label', stripWrapper('FINAL: hello'), 'hello')
  deepEqual('parseEditorOutput splits report', parseEditorOutput('=== FINAL ===\nbody\n=== REPORT ===\n- one\n- two'), {
    final: 'body', report: ['one', 'two'], parsed: true, usedMarker: true,
  })
  deepEqual('parseEditorOutput final without report', parseEditorOutput('=== FINAL ===\nonly text'), {
    final: 'only text', report: [], parsed: false, usedMarker: true,
  })
  const unmarked = parseEditorOutput('just text')
  check('parseEditorOutput unmarked final', unmarked.final, 'just text')
  check('parseEditorOutput unmarked flag', unmarked.parsed, false)
  check('parseEditorOutput unmarked usedMarker', unmarked.usedMarker, false)
  check('missingNumbers detects a drop', missingNumbers('grew 12% and 48 units', 'grew 12% overall').join(','), '48')
  check('missingNumbers silent when kept', missingNumbers('grew 12%', 'it grew by 12% in total').length, 0)
  deepEqual('sampleForAnalysis short', sampleForAnalysis('abc', 100), { body: 'abc', sampled: false })
  ok('sampleForAnalysis long flags sampling', sampleForAnalysis('x'.repeat(500), 100).sampled)
  ok('draftRatioOk rejects summary', draftRatioOk('short', 'x'.repeat(100)).ok === false)
}

/* ------------------------------------------------------------------ */
/* Argument and configuration validation                               */
/* ------------------------------------------------------------------ */

{
  deepEqual('normalizeArgs defaults', normalizeArgs({ text: 'hi' }), {
    text: 'hi', path: undefined, tone: 'match', intensity: 'balanced', notes: undefined,
  })
  let threw = false
  try { normalizeArgs({}) } catch { threw = true }
  ok('normalizeArgs requires content', threw)

  threw = false
  try { normalizeArgs({ text: 'a', path: 'b' }) } catch { threw = true }
  ok('normalizeArgs rejects both inputs', threw)

  threw = false
  try { normalizeArgs({ text: 'a', tone: 'pirate' }) } catch { threw = true }
  ok('normalizeArgs rejects unknown tone', threw)

  deepEqual('normalizeSettings defaults', Object.keys(normalizeSettings(undefined)).sort(),
    ['briefChars', 'maxInputChars', 'maxSections', 'maxTokens', 'model', 'provider', 'sampleChars', 'sectionChars', 'temperature'])

  threw = false
  try { normalizeSettings({ sectionChars: 0 }) } catch { threw = true }
  ok('normalizeSettings rejects zero', threw)
}

/* ------------------------------------------------------------------ */
/* Plugin registration and pipeline                                    */
/* ------------------------------------------------------------------ */

{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, {})
  ok('apply registers a tool', state.tool !== undefined)
  check('tool name', state.tool.name, 'humanize')
  check('plugin name', pluginName, 'humanize')
  deepEqual('plugin inject', inject, ['tools'])
  ok('tool description is substantial', state.tool.description.length > 200)
  check('parameters root type', state.tool.parameters.type, 'object')
  check('output schema requires text', state.tool.output.schema.required.includes('text'), true)
  ok('render is a function', typeof state.tool.output.render === 'function')
}

/* A normal small document: one analyst call, then a rewrite and an edit. */
{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, {})
  const value = await (state.tool.execute({ text: SAMPLE_DOC }, { signal: new AbortController().signal }))
  check('sections for sample doc', value.sections, 1)
  check('route provider', value.route.provider, 'stub-provider')
  check('route model', value.route.model, 'stub-model')
  check('final keeps heading', value.text.includes('# Quarterly logistics review'), true)
  ok('final carries rewritten text', value.text.includes('Rewritten:'))
  deepEqual('report from editor', value.report, ['tightened the opening'])
  deepEqual('no warnings', value.warnings, [])
  check('originalChars', value.originalChars, SAMPLE_DOC.length)
  check('finalChars', value.finalChars, value.text.length)
  const roles = state.sources.map(entry => entry.role)
  deepEqual('three agents ran in order', roles, ['analyst', 'rewriter', 'editor'])
  const rendered = state.tool.output.render({}, value)
  check('render returns one text block', rendered.length, 1)
  ok('render includes the final text', rendered[0].text.includes(value.text))
  ok('render includes the model route', rendered[0].text.includes('stub-provider/stub-model'))
  ok('render includes the change report', rendered[0].text.includes('What changed'))
  ok('render includes a report line', rendered[0].text.includes('tightened the opening'))
}

/* A rewrite much shorter than its source is flagged for the caller. */
{
  const responder = scriptedResponder({
    rewriter: section => `Rewritten briefly: ${section.slice(0, Math.floor(section.length * 0.65))}`,
    editor: draft => `=== FINAL ===\n${draft}\n=== REPORT ===\n- compressed`,
  })
  const { ctx, state } = createHarness({ responder })
  apply(ctx, {})
  const value = await (state.tool.execute({ text: LONG_DOC }, { signal: new AbortController().signal }))
  ok('length drift warns', value.warnings.some(line => line.includes('shorter than the source')))
}

/* A long document: one analyst call, then two calls per section. */
{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, { sectionChars: 1200 })
  const value = await (state.tool.execute({ text: LONG_DOC, intensity: 'strong', tone: 'academic' }, { signal: new AbortController().signal }))
  ok('long doc has several sections', value.sections > 1)
  check('call count matches sections', state.sources.length, 1 + value.sections * 2)
  ok('prompt carries the tone', state.sources.some(entry => entry.input.includes('formal academic register')))
  ok('prompt carries the latitude', state.sources.some(entry => entry.input.includes('Restructure sentences')))
  check('no lost paragraphs', (value.text.match(/Paragraph \d\./g) ?? []).length, 6)
}

/* The editor reports markers incorrectly, and a rewriter summarizes. */
{
  const responder = scriptedResponder({
    rewriter: section => 'Too short.',
    editor: draft => `no markers here\n${draft}`,
  })
  const { ctx, state } = createHarness({ responder })
  apply(ctx, {})
  const value = await (state.tool.execute({ text: SAMPLE_DOC }, { signal: new AbortController().signal }))
  ok('rejected draft warns', value.warnings.some(line => line.includes('source length')))
  ok('missing markers warn', value.warnings.some(line => line.includes('output markers')))
  ok('fallback keeps the original words', value.text.includes('leveraged cross-functional synergy'))
}

/* A dropped figure is reported back to the caller. */
{
  const responder = scriptedResponder({
    editor: () => '=== FINAL ===\nThe programme grew without numbers.\n=== REPORT ===\n- removed the figures',
  })
  const { ctx, state } = createHarness({ responder })
  apply(ctx, {})
  const value = await (state.tool.execute({ text: 'Revenue grew 12% to 48 million in 2023.' }, { signal: new AbortController().signal }))
  ok('dropped figures warned', value.warnings.some(line => line.includes('figures in the source')))
  ok('warning names a figure', value.warnings.some(line => line.includes('12%')))
}

/* A figure that the rewrite invented is reported too. */
{
  const responder = scriptedResponder({
    editor: () => '=== FINAL ===\nRevenue grew 12% to 51 million in 2023.\n=== REPORT ===\n- rounded the total',
  })
  const { ctx, state } = createHarness({ responder })
  apply(ctx, {})
  const value = await (state.tool.execute({ text: 'Revenue grew 12% to 48 million in 2023.' }, { signal: new AbortController().signal }))
  ok('invented figures warned', value.warnings.some(line => line.includes('do not appear in the source')))
}

/* One failing section keeps its source text and the rest still completes. */
{
  const responder = scriptedResponder({
    rewriter: section => {
      if (section.includes('Paragraph 3')) throw new Error('provider exploded')
      return `Rewritten: ${section}`
    },
  })
  const { ctx, state } = createHarness({ responder })
  apply(ctx, { sectionChars: 1200 })
  const value = await (state.tool.execute({ text: LONG_DOC }, { signal: new AbortController().signal }))
  ok('failed section warned', value.warnings.some(line => line.includes('provider exploded')))
  ok('failed section keeps its text', value.text.includes('Paragraph 3.'))
  ok('other sections still rewritten', (value.text.match(/Rewritten:/g) ?? []).length >= 1)
  check('all paragraphs survive a partial failure', (value.text.match(/Paragraph \d\./g) ?? []).length, 6)
}

/* Cancellation propagates instead of producing a partial document. */
{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, {})
  const controller = new AbortController()
  controller.abort()
  let error
  try {
    await (state.tool.execute({ text: SAMPLE_DOC }, { signal: controller.signal }))
  } catch (caught) {
    error = caught
  }
  ok('aborted run throws', error !== undefined)
}

/* An empty document and an oversized document are refused. */
{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, {})
  let threw = false
  try { await (state.tool.execute({ text: '   ' }, { signal: new AbortController().signal })) } catch { threw = true }
  ok('empty document refused', threw)

  const tiny = createHarness({ responder: scriptedResponder() })
  apply(tiny.ctx, { maxInputChars: 10 })
  threw = false
  try { await (tiny.state.tool.execute({ text: 'x'.repeat(50) }, { signal: new AbortController().signal })) } catch { threw = true }
  ok('oversized document refused', threw)
}

/* A file path is read through the Host filesystem service. */
{
  const written = []
  const fakeFs = {
    async resolve(path, opts) { return { targetKey: 'k', displayPath: `/virtual/${path}`, cwd: opts?.cwd } },
    async stat() { return { version: 'v1', type: 'file', size: 10 } },
    async readText() { return SAMPLE_DOC },
  }
  const { ctx, state } = createHarness({ responder: scriptedResponder(), fs: fakeFs })
  apply(ctx, {})
  const value = await (state.tool.execute({ path: 'draft.md' }, { signal: new AbortController().signal }))
  ok('path run produces text', value.text.length > 0)
  ok('source path is returned', value.sourcePath.includes('/virtual/draft.md'))
  ok('source path is not a change line', value.report.every(line => !line.includes('/virtual/')))
  ok('source path renders in the header', state.tool.output.render({}, value)[0].text.includes('read only'))
  ok('working directory was not available', written.length === 0)
}

/* Route overrides from configuration win over the default model. */
{
  const { ctx, state } = createHarness({ responder: scriptedResponder() })
  apply(ctx, { provider: 'other-provider', model: 'other-model' })
  const value = await (state.tool.execute({ text: SAMPLE_DOC }, { signal: new AbortController().signal }))
  deepEqual('configured route used', value.route, { provider: 'other-provider', model: 'other-model' })
}

/* A profile without model selection fails with an actionable message. */
{
  const { ctx, state } = createHarness({
    responder: scriptedResponder(),
    selection: undefined,
  })
  apply(ctx, {})
  let message = ''
  try { await (state.tool.execute({ text: SAMPLE_DOC }, { signal: new AbortController().signal })) } catch (error) { message = String(error) }
  ok('missing route is explained', message.includes('provider') && message.includes('model'))
}

/* ------------------------------------------------------------------ */

console.log(`\n${checks} checks, ${failures} failure(s)`)
if (failures > 0) process.exitCode = 1
