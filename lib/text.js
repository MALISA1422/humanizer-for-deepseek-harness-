/**
 * Pure document utilities for the humanizer pipeline: section planning, output
 * unwrapping, and the deterministic checks that run beside the model passes.
 * No Host services and no model calls live here, so every function is testable
 * with plain strings.
 * @module humanizer/lib/text
 */

/** Markdown ATX heading, or a setext heading line, used to keep section starts clean. */
const ATX_HEADING = /^\s{0,3}#{1,6}\s+\S/
const SETEXT_UNDERLINE = /^\s{0,3}(?:={3,}|-{3,})\s*$/

/**
 * Treat a block as a heading so a section title never ends up last in a chunk.
 * @param {string} block - one paragraph-level block.
 * @returns {boolean} whether the block is a heading.
 */
export function isHeading(block) {
  const lines = block.split('\n')
  const first = lines[0] ?? ''
  if (ATX_HEADING.test(first)) return true
  const second = lines[1]
  return lines.length > 1 && second !== undefined && SETEXT_UNDERLINE.test(second) && first.trim() !== ''
}

/**
 * Split text into paragraph blocks, preserving the dominant blank-line style.
 * @param {string} text - source document.
 * @returns {{ blocks: string[], separator: string }} blocks and the separator to join them with.
 */
export function splitIntoBlocks(text) {
  const normalized = text.replace(/\r\n?/g, '\n')
  const blocks = normalized
    .split(/\n{2,}/)
    .map(block => block.replace(/\s+$/, ''))
    .filter(block => block.trim() !== '')
  const separator = /\n{2,}/.test(normalized) ? '\n\n' : '\n'
  return { blocks, separator }
}

/**
 * Split one oversized block into sentence-aligned pieces no longer than the limit.
 * @param {string} block - a paragraph that exceeds the section budget.
 * @param {number} limit - maximum characters per piece.
 * @returns {string[]} pieces in source order.
 */
export function splitLongBlock(block, limit) {
  const sentences = block.match(/[^.!?\n]+(?:[.!?]+["')\]]*\s*)?/g) ?? [block]
  const pieces = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current !== '') {
        pieces.push(current.trim())
        current = ''
      }
      for (let offset = 0; offset < sentence.length; offset += limit) {
        pieces.push(sentence.slice(offset, offset + limit).trim())
      }
      continue
    }
    if (current !== '' && current.length + sentence.length > limit) {
      pieces.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim() !== '') pieces.push(current.trim())
  return pieces.filter(piece => piece !== '')
}

/**
 * Plan model-sized sections for one document.
 *
 * A heading always opens a section, so a rewrite pass never receives a section
 * that begins inside the previous one's body. Every section carries the
 * separator that follows it, which lets sentence-level splits rejoin with a
 * space while paragraph splits rejoin with a blank line.
 * @param {string} text - source document.
 * @param {number} limit - target maximum characters per section.
 * @returns {{ sections: { text: string, sep: string }[], separator: string, blocks: number }} the plan.
 */
export function planSections(text, limit) {
  const { blocks, separator } = splitIntoBlocks(text)
  const sections = []
  let current = []
  let currentChars = 0

  const flush = () => {
    if (current.length === 0) return
    sections.push({ text: current.join(separator), sep: separator })
    current = []
    currentChars = 0
  }

  for (const block of blocks) {
    if (isHeading(block) && current.length > 0) flush()

    if (block.length > limit) {
      flush()
      const pieces = splitLongBlock(block, limit)
      pieces.forEach((piece, index) => {
        sections.push({ text: piece, sep: index === pieces.length - 1 ? separator : ' ' })
      })
      continue
    }

    if (current.length > 0 && currentChars + separator.length + block.length > limit) flush()
    current.push(block)
    currentChars += (current.length === 1 ? 0 : separator.length) + block.length
  }
  flush()

  if (sections.length === 0) sections.push({ text: text.trim(), sep: '' })
  return { sections, separator, blocks: blocks.length }
}

/**
 * Reassemble rewritten sections using the separators the plan prescribed.
 * @param {string[]} parts - one final text per section, in order.
 * @param {{ text: string, sep: string }[]} sections - the plan those parts came from.
 * @returns {string} the joined document, with trailing blank lines removed.
 */
export function joinSections(parts, sections) {
  let out = ''
  for (let index = 0; index < parts.length; index++) {
    const section = sections[index]
    const part = parts[index] ?? ''
    out += part
    if (index < parts.length - 1) out += section?.sep ?? '\n\n'
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Remove a wrapper a model added around otherwise usable text: a single fenced
 * block, a leading `FINAL:` label, or an echoed `=== FINAL ===` marker.
 * @param {string} raw - model output.
 * @returns {string} the unwrapped text.
 */
export function stripWrapper(raw) {
  let text = raw.replace(/\r\n?/g, '\n').trim()

  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()

  const marker = text.indexOf('=== FINAL ===')
  if (marker !== -1) text = text.slice(marker + '=== FINAL ==='.length).trim()
  const reportAt = text.indexOf('=== REPORT ===')
  if (reportAt !== -1) text = text.slice(0, reportAt).trim()

  text = text.replace(/^(?:FINAL|REWRITE|REWRITTEN TEXT|OUTPUT)\s*:\s*/i, '')
  return text.trim()
}

/**
 * Split the editor agent's reply into its final text and its change report.
 * @param {string} raw - editor model output.
 * @returns {{ final: string, report: string[], parsed: boolean, usedMarker: boolean }} the final text, its report, whether the report marker was present, and whether the final marker was present at all.
 */
export function parseEditorOutput(raw) {
  const text = raw.replace(/\r\n?/g, '\n')
  const finalMarker = '=== FINAL ==='
  const reportMarker = '=== REPORT ==='
  const finalAt = text.indexOf(finalMarker)

  if (finalAt === -1) {
    const reportAt = text.indexOf(reportMarker)
    const body = reportAt === -1 ? text : text.slice(0, reportAt)
    const report = reportAt === -1 ? [] : parseReport(text.slice(reportAt + reportMarker.length))
    return { final: stripWrapper(body), report, parsed: false, usedMarker: false }
  }

  const afterFinal = text.slice(finalAt + finalMarker.length)
  const reportAt = afterFinal.indexOf(reportMarker)
  const finalBody = reportAt === -1 ? afterFinal : afterFinal.slice(0, reportAt)
  const report = reportAt === -1 ? [] : parseReport(afterFinal.slice(reportAt + reportMarker.length))
  return { final: finalBody.trim(), report, parsed: reportAt !== -1, usedMarker: true }
}

/**
 * Read report bullets, dropping empty lines and normalizing markers.
 * @param {string} body - text after the report marker.
 * @returns {string[]} at most 40 one-line findings.
 */
export function parseReport(body) {
  return body
    .split('\n')
    .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(line => line !== '')
    .slice(0, 40)
}

/**
 * Collect numeric mentions so a rewrite can be checked for dropped figures.
 * @param {string} text - any document text.
 * @returns {Set<string>} normalized numeric tokens, in first-seen order.
 */
export function numericMentions(text) {
  const found = new Set()
  for (const match of text.matchAll(/\d+(?:[.,]\d+)*\s?(?:%|percent)?/gi)) {
    const token = match[0].replace(/\s+/g, '').toLowerCase()
    if (token.length > 0) found.add(token)
  }
  return found
}

/**
 * Report figures present in the source but missing from the rewrite. This is a
 * deterministic hint for the calling agent, not a correctness verdict: a rewrite
 * may legitimately spell a number as a word or restructure a range.
 * @param {string} source - original document.
 * @param {string} rewritten - final document.
 * @param {number} limit - maximum findings to return.
 * @returns {string[]} missing numeric tokens.
 */
export function missingNumbers(source, rewritten, limit = 12) {
  const rewrittenTokens = numericMentions(rewritten)
  const missing = []
  for (const token of numericMentions(source)) {
    if (!rewrittenTokens.has(token)) missing.push(token)
    if (missing.length >= limit) break
  }
  return missing
}

/**
 * Build the digest the analyst reads when a document exceeds its sample budget:
 * the opening, a middle window, and the closing of the document.
 * @param {string} text - source document.
 * @param {number} budget - total characters the analyst may read.
 * @returns {{ body: string, sampled: boolean }} digest text and whether sampling occurred.
 */
export function sampleForAnalysis(text, budget) {
  if (text.length <= budget) return { body: text, sampled: false }
  const head = Math.floor(budget * 0.45)
  const middle = Math.floor(budget * 0.2)
  const tail = budget - head - middle
  const middleAt = Math.max(head, Math.floor((text.length - middle) / 2))
  const body = [
    text.slice(0, head).trim(),
    '[… document continues …]',
    text.slice(middleAt, middleAt + middle).trim(),
    '[… document continues …]',
    text.slice(Math.max(0, text.length - tail)).trim(),
  ].join('\n\n')
  return { body, sampled: true }
}

/**
 * Keep a brief from consuming the rewriter's context budget.
 * @param {string} brief - analyst output.
 * @param {number} maxChars - hard cap.
 * @returns {string} the brief, truncated at a line boundary when needed.
 */
export function clampBrief(brief, maxChars) {
  const trimmed = brief.trim()
  if (trimmed.length <= maxChars) return trimmed
  const cut = trimmed.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  return `${lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut}\n[brief truncated]`
}

/**
 * Reject a rewrite that lost too much of its source, which usually means the
 * model summarized, refused, or truncated.
 * @param {string} draft - rewritten section.
 * @param {string} source - original section.
 * @param {number} minimumRatio - smallest acceptable draft/source length ratio.
 * @returns {{ ok: boolean, ratio: number }} the verdict and the measured ratio.
 */
export function draftRatioOk(draft, source, minimumRatio = 0.4) {
  if (source.length === 0) return { ok: true, ratio: 1 }
  const ratio = draft.length / source.length
  return { ok: ratio >= minimumRatio, ratio: Number(ratio.toFixed(2)) }
}
