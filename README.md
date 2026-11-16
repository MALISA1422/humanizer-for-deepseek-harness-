# Humanizer

A DeepSeek Harness bundle that adds one tool, `humanize`, which rewrites a
document so it reads as human-written while keeping its content intact.

## The three agents

| Pass | Agent | Job |
| --- | --- | --- |
| 1 | Voice Analyst | Reads the document once and writes a brief: the specific machine-written patterns it found, the facts/figures/names a rewrite must keep, and concrete moves for the other two agents. It never rewrites. |
| 2 | Rewriter | Rewrites one section at a time so the rhythm varies, filler and hedges go, and abstract phrasing becomes the concrete specifics already in the source. |
| 3 | Editor | Compares each draft against its source clause by clause. Restores dropped facts, deletes anything invented, removes surviving tells, and returns the final text plus a change report. |

The pipeline never adds facts. The editor is explicitly instructed to delete
content the rewriter invented, and the tool reports any figure from the source
that no longer appears verbatim.

## Using it

Ask the agent to humanize a text or a file, or call the tool directly:

```text
humanize(text: "...")
humanize(path: "draft.md", tone: "academic", intensity: "light")
```

| Parameter | Meaning |
| --- | --- |
| `text` | The full text to humanize. |
| `path` | UTF-8 text or Markdown file; relative paths resolve against the session working directory. |
| `tone` | `match` (default), `academic`, `professional`, `casual`, `journalistic`. |
| `intensity` | `light` (tells only), `balanced` (default), `strong` (may restructure paragraphs). |
| `notes` | Extra constraints, such as an audience or a word limit. |

Some results of a run worth reading: `text` is the final document, `warnings`
lists anything that needs a human look (a truncated section, a section whose
rewrite was rejected, figures that no longer match), and `report` is the
editor's change list.

## Configuration

The plugin row's `config` accepts these optional keys. All are optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | current default model | Model provider route for the three passes. Must be set together with `model`. |
| `model` | current default model | Model id for the three passes. |
| `sectionChars` | `6000` | Target characters per section; larger sections mean fewer, longer model calls. |
| `sampleChars` | `18000` | How much of a long document the analyst reads (head, middle window, tail). |
| `briefChars` | `5000` | Cap on the analyst brief carried into the other passes. |
| `maxInputChars` | `200000` | Refuse documents larger than this instead of silently splitting them. |
| `maxSections` | `40` | Refuse documents that need more than this many sections. |
| `maxTokens` | model default | Output cap for each pass. |
| `temperature` | model default | Sampling temperature, when the configured model accepts one. |

## Cost and privacy

One analyst call plus two calls per section. A 12 000-character document at the
default 6 000-character sections is two sections, so five calls. The text you
pass goes to the model provider already configured for the session and nowhere
else. The plugin keeps no copy: its state lives in the tool result in the
session log. A file named with `path` is only read, never rewritten — the tool
returns the new text so the caller decides where it goes.

## Limits

- It improves how the prose reads. It cannot promise any particular AI
  detector's verdict, and detectors misclassify both human and model writing.
- It only rewrites text that already exists; it does not write new content.
- Invented content is forbidden by the prompts, not proven absent. The
  deterministic checks cover figures only: a source figure that disappears and a
  final figure that never appeared in the source are both reported.
- Paragraph separation is normalized to blank lines, and per-section rewrites
  are reassembled from the plan, so unusual layout (tables, code blocks,
  footnotes) is passed through as ordinary text and may need a manual check.
- A section whose model call fails keeps its original text and is reported;
  the rest of the document still completes. Cancelling the call aborts the run.
- Documents above `maxInputChars` or `maxSections` are refused rather than
  partially processed.
- Warnings are capped at 24 and change lines at 30; anything beyond that is
  summarized as an omitted count.

## Layout

```text
index.js            tool definition and pipeline orchestration
lib/complete.js     one-shot model call over the Host `llm` service
lib/prompts.js      the three agent prompts and their input builders
lib/text.js         section planning, output parsing, deterministic checks
locale/en.json      display metadata
docs/DETAIL.md      plugin detail document (one image)
```

## License

MIT. Copyright (c) 2026 The Humanizer authors. The code, the icon, and the
detail illustration are original to this bundle; the package depends on no
third-party code of its own.

