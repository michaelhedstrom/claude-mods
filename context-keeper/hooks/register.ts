import type { EngineInterface, Register, SessionCompactResult } from 'claude-code'
import { update } from 'claude-code'
import type { Ledger, Note } from '../types'

const ledger = { plugin: 'context-keeper', key: 'ledger' } as const
const NOTE_TOOL = 'mcp__context-keeper__note'
const KINDS = ['decision', 'correction', 'constraint', 'verified', 'open']
const EMPTY: Ledger = { notes: [], files: [], snapshot: '', lastCompactTokens: 0 }
// a full ledger is about 3k tokens on every request; past it, merge instead
const MAX_NOTES = 60
// ponytail: fixed cap; raise if a session genuinely needs more
const MAX_FILES = 200

const NOTE_DESCRIPTION = `Record session memory that must survive context compaction. Call it the moment one of these happens, one short self-contained line each:
- decision: a choice made, with the alternatives rejected and why
- correction: a user correction or standing instruction, quoted
- constraint: a fact, gotcha or cause of failure learned the hard way
- verified: what was actually run or tested, and the result
- open: a question or blocker still unresolved
Notes are shown back after compaction as #n. Pass replaces: n when a note is superseded or resolved. Do not record routine progress.`

const CHECKLIST = `This session continues after compaction, and the summary is its memory of everything above. Carry forward everything from any earlier summary unless it was explicitly superseded. Include:

1. Goal: the user's overall objective and the current sub-task.
2. User instructions and corrections still in effect, quoted verbatim.
3. Decisions: each decision, the alternatives rejected, and why.
4. Constraints and facts learned: environment quirks, gotchas, what failed and why.
5. Work done: for each file touched, one line on what changed.
6. Verification: what was actually run and passed, and what is still unverified.
7. Open questions and blockers.
8. The exact next step, and anything in flight (running processes, half-applied changes).

Keep paths, names, commands, IDs and error messages exact. Aim for under about 4,000 tokens, but never drop a decision, a correction or the next step to fit.`

const nudgeText = (count: number): string =>
  `context-keeper: the ledger holds ${count} note${count === 1 ? '' : 's'}. Before this turn ends: if it produces a decision, a user correction (quote it), a constraint learned or a verified result, record it with the note tool; if it supersedes or overlaps an existing note, merge it with replaces: n. Otherwise skip it. Never note routine progress.`

const RECONCILE = `You maintain a session ledger: short notes that must survive context compaction. Below are the current notes and a fresh summary of the session. Return the reconciled ledger as a JSON array of {"kind","text"} objects and nothing else.

- kind is one of: decision, correction, constraint, verified, open.
- Keep every existing note unless the summary shows it superseded or resolved. Merge notes that overlap into one.
- Keep corrections word for word.
- Add any decision (with alternatives rejected and why), user correction (quoted), constraint, verified result or open question from the summary that the notes lack.
- One short self-contained line each, paths, names and IDs exact. No routine progress. At most ${MAX_NOTES} notes.

Return {"keywords":[...],"notes":[...]}: keywords are 3 to 6 short lowercase search terms naming what the session is about (features, systems, bugs), and notes the reconciled array.`

const LEDGER_NOTE = `The session ledger below (notes, files touched) is re-injected verbatim after compaction, so do not copy it. Keep the summary consistent with it and cover what it lacks.`

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n))

const numberOption = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

export const formatLedger = (value: Ledger): string =>
  [
    value.notes.length > 0 &&
      `Notes:\n${value.notes.map((n, i) => `#${i + 1} [${n.kind}] ${n.text}`).join('\n')}`,
    value.files.length > 0 && `Files touched:\n${value.files.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')

export const buildInstructions = (parts: {
  focus?: string
  ledger?: Ledger
  git?: string
}): string => {
  const ledgerText = parts.ledger ? formatLedger(parts.ledger) : ''
  return [
    parts.focus && `User's focus for this compaction: ${parts.focus}`,
    CHECKLIST,
    ledgerText && `${LEDGER_NOTE}\n\n${ledgerText}`,
    parts.git && `Git state now:\n${parts.git}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const shouldCompact = (
  tokens: number,
  trigger: number,
  lastCompactTokens: number
): boolean =>
  // after a compaction, wait for real growth so a heavy baseline can't loop
  tokens >= trigger && tokens >= lastCompactTokens + trigger / 4

const bar = (fraction: number, width = 10): string => {
  const filled = Math.round(clamp(fraction, 0, 1) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

export const statusText = (
  tokens: number,
  trigger: number,
  noteCount: number
): string => {
  const left = Math.max(0, trigger - tokens)
  const until = left > 0 ? `${kTokens(left)} left` : 'compacts after this turn'
  const notes = noteCount > 0 ? ` · ✎ ${noteCount}` : ''
  return `ctx ${bar(tokens / trigger)} ${kTokens(tokens)}/${kTokens(trigger)} · ${until}${notes}`
}

const dataPath = async (
  $: EngineInterface,
  id: string,
  suffix: string
): Promise<string | undefined> => {
  const home = await $.env.get('HOME')
  return home && `${home}/.claude/context-keeper/${id}${suffix}`
}

const persist = async ($: EngineInterface, id: string, value: Ledger): Promise<void> => {
  const path = await dataPath($, id, '.json')
  if (path) {
    await $.fs.write(path, JSON.stringify(value, null, 2)).catch(() => undefined)
  }
}

const isLedger = (value: unknown): value is Ledger =>
  typeof value === 'object' &&
  value !== null &&
  'notes' in value &&
  Array.isArray(value.notes) &&
  'files' in value &&
  Array.isArray(value.files)

const load = async (
  $: EngineInterface
): Promise<{ id: string; value: Ledger }> => {
  const id = await $.session.id()
  const ref = { ...ledger, id }
  const held = await $.state.get(ref)
  if (held.version > 0 && held.value) {
    return { id, value: held.value }
  }
  // a resumed session after a restart: pick the ledger back up from disk
  const path = await dataPath($, id, '.json')
  const restored = path
    ? await $.fs
        .read(path)
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined)
    : undefined
  if (isLedger(restored)) {
    await $.state.set(ref, restored, { ifVersion: 0 })
    return { id, value: restored }
  }
  return { id, value: EMPTY }
}

const change = async (
  $: EngineInterface,
  fn: (value: Ledger) => Ledger
): Promise<{ id: string; value: Ledger }> => {
  const { id } = await load($)
  const value = await update($, { ...ledger, id }, (v = EMPTY) => {
    const next = fn(v)
    return next.cwd === undefined && sessionCwd !== undefined ? { ...next, cwd: sessionCwd } : next
  })
  await persist($, id, value)
  return { id, value }
}

// set at session.start; module state, so a reload sets it again
let sessionCwd: string | undefined

// --- finding earlier sessions' ledgers -------------------------------------

type Found = { id: string; mtimeMs: number; value: Ledger }

const dirPath = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await $.env.get('HOME')
  return home && `${home}/.claude/context-keeper`
}

// ponytail: reads every ledger file per call; fine for hundreds, index if it grows to thousands
const allLedgers = async ($: EngineInterface, exceptId: string): Promise<Found[]> => {
  const dir = await dirPath($)
  if (!dir) {
    return []
  }
  const entries = await $.fs.list(dir).catch(() => [])
  const found = await Promise.all(
    entries
      .filter((f) => f.kind === 'file' && f.name.endsWith('.json') && f.name !== `${exceptId}.json`)
      .map(async (f) => {
        const value = await $.fs
          .read(`${dir}/${f.name}`)
          .then((text) => (typeof text === 'string' ? (JSON.parse(text) as unknown) : undefined))
          .catch(() => undefined)
        return isLedger(value) && value.notes.length > 0
          ? { id: f.name.slice(0, -'.json'.length), mtimeMs: f.mtimeMs, value }
          : undefined
      })
  )
  return found.filter((f): f is Found => f !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const matches = (f: Found, word: string): boolean => {
  const w = word.toLowerCase()
  return [...(f.value.keywords ?? []), f.value.cwd ?? '', ...f.value.notes.map((n) => n.text)].some((t) =>
    t.toLowerCase().includes(w)
  )
}

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const describe = (f: Found): string => {
  const date = new Date(f.mtimeMs).toISOString().slice(0, 10)
  const project = f.value.cwd?.split('/').filter(Boolean).at(-1) ?? '?'
  const lead =
    f.value.notes.find((n) => n.kind === 'open') ?? f.value.notes.find((n) => n.kind === 'decision') ?? f.value.notes[0]
  const about = f.value.keywords?.length ? f.value.keywords.join(', ') : short(lead?.text ?? '', 70)
  return `${date} · ${project} · ${f.id.slice(0, 8)} · ${f.value.notes.length} notes · ${about}`
}

const RECENT_COUNT = 5

const recentSection = async ($: EngineInterface, id: string, cwd: string): Promise<string> => {
  const here = (await allLedgers($, id)).filter((f) => f.value.cwd === cwd).slice(0, RECENT_COUNT)
  return here.length === 0
    ? ''
    : `Earlier session ledgers in this project, newest first. If the user's task matches one, offer \`/ledgers load <id>\` (copies its notes in) or \`claude --resume <full id>\`; don't load one unasked.\n${here.map((f) => `- ${describe(f)} (id ${f.id})`).join('\n')}`
}

let recentText = ''

const ledgersCommand = async ($: EngineInterface, args: string): Promise<{ text: string; context?: string[] }> => {
  const { id } = await load($)
  const [verb, ...rest] = args.trim().split(/\s+/)
  if (verb === 'load') {
    const prefix = rest[0] ?? ''
    const hits = prefix === '' ? [] : (await allLedgers($, id)).filter((f) => f.id.startsWith(prefix))
    const [from] = hits
    if (from === undefined || hits.length !== 1) {
      return { text: hits.length === 0 ? `No ledger with id ${prefix || '(none given)'}.` : `${hits.length} ledgers start with ${prefix}; give more of the id.` }
    }
    let added: Note[] = []
    const { value } = await change($, (v) => {
      added = from.value.notes.filter((n) => !v.notes.some((m) => m.text === n.text)).slice(0, MAX_NOTES - v.notes.length)
      return { ...v, notes: [...v.notes, ...added] }
    })
    const skipped = from.value.notes.length - added.length
    return {
      text: `Loaded ${added.length} notes from ${from.id.slice(0, 8)} (${describe(from)})${skipped > 0 ? `; ${skipped} already held or over the ${MAX_NOTES}-note cap` : ''}.`,
      context: [
        `Notes loaded from earlier session ${from.id} into this session's ledger; treat them as authoritative as your own:\n${formatLedger({ ...value, files: [] })}`,
      ],
    }
  }
  const word = args.trim()
  const all = await allLedgers($, id)
  const hits = (word === '' ? all : all.filter((f) => matches(f, word))).slice(0, 10)
  if (hits.length === 0) {
    return { text: word === '' ? 'No earlier ledgers with notes.' : `No ledger mentions "${word}".` }
  }
  return {
    text: `${hits.map((f) => `${describe(f)}\n    /ledgers load ${f.id.slice(0, 8)}  ·  claude --resume ${f.id}`).join('\n')}`,
  }
}

const gitState = async ($: EngineInterface): Promise<string> => {
  const run = (argv: readonly string[]): Promise<string> =>
    $.process
      .run(argv, { timeoutMs: 3000 })
      .then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''))
      .catch(() => '')
  const [status, log] = await Promise.all([
    run(['git', 'status', '--porcelain=v1', '--branch']),
    run(['git', 'log', '--oneline', '-5']),
  ])
  return [status.slice(0, 4000), log && `Recent commits:\n${log}`]
    .filter(Boolean)
    .join('\n\n')
}

const mainInstructions = async (
  $: EngineInterface,
  focus: string | undefined
): Promise<string> => {
  const [{ value }, git] = await Promise.all([load($), gitState($)])
  return buildInstructions({ focus, ledger: value, git })
}

type Reconciled = { notes: Note[]; keywords?: string[] }

// the object form carries keywords; a bare array (older prompt) is notes alone
export const parseReconciled = (text: string, held: readonly Note[]): Reconciled | undefined => {
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  const isObject = brace !== -1 && (bracket === -1 || brace < bracket)
  const json = isObject
    ? text.slice(brace, text.lastIndexOf('}') + 1)
    : text.slice(bracket, text.lastIndexOf(']') + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  const raw: unknown = isObject && typeof parsed === 'object' && parsed !== null && 'notes' in parsed ? parsed.notes : parsed
  const words: unknown =
    isObject && typeof parsed === 'object' && parsed !== null && 'keywords' in parsed ? parsed.keywords : undefined
  const keywords = Array.isArray(words)
    ? words.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map((w) => w.trim().toLowerCase()).slice(0, 8)
    : undefined
  const notes = parseNoteArray(raw, held)
  return notes && { notes, keywords: keywords && keywords.length > 0 ? keywords : undefined }
}

const parseNoteArray = (raw: unknown, held: readonly Note[]): Note[] | undefined => {
  if (!Array.isArray(raw) || raw.length > MAX_NOTES) {
    return undefined
  }
  const at = new Date().toISOString()
  const notes: Note[] = []
  for (const item of raw) {
    const kind: unknown = item?.kind
    const text: unknown = item?.text
    if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof text !== 'string' || text.trim() === '') {
      return undefined
    }
    const same = held.find((n) => n.kind === kind && n.text === text.trim())
    notes.push(same ?? { kind, text: text.trim(), at })
  }
  return notes
}

// fold what the summary knows into the notes; on any failure keep them as they are
const reconcile = async (
  $: EngineInterface,
  held: readonly Note[],
  summary: string
): Promise<Reconciled | undefined> => {
  const notes = held.map((n) => `- [${n.kind}] ${n.text}`).join('\n') || '(none)'
  const r = await $.model
    .complete({
      model: 'sonnet',
      system: RECONCILE,
      prompt: `Current notes:\n${notes}\n\nSession summary:\n${summary}`,
      maxTokens: 8000,
      // ponytail: awaited, so a slow reply holds the compaction up to this long
      timeoutMs: 60_000,
    })
    .catch(() => undefined)
  return r?.isAnswered ? parseReconciled(r.text, held) : undefined
}

const recordCompaction = async (
  $: EngineInterface,
  result: SessionCompactResult,
  maxTokens: number
): Promise<void> => {
  if (result.skip !== undefined) {
    return
  }
  const summary = result.messages.map((m) => m.text).join('\n\n')
  const { value: held } = await load($)
  const reconciled = summary ? await reconcile($, held.notes, summary) : undefined
  const notes = reconciled?.notes
  const { id } = await change($, (v) => ({
    ...v,
    notes: notes ?? v.notes,
    keywords: reconciled?.keywords ?? v.keywords,
    snapshot: formatLedger({ ...v, notes: notes ?? v.notes }),
    // ponytail: half the trigger when core doesn't report the size afterwards
    lastCompactTokens: result.tokensAfter ?? maxTokens / 2,
  }))
  const summaryPath = await dataPath($, id, '-summary.md')
  if (summaryPath) {
    await $.fs.write(summaryPath, summary).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const percent = clamp(numberOption(options.threshold, 50), 20, 90)
  const maxTokens = Math.max(50_000, numberOption(options.maxTokens, 400_000))
  const showRecent = options.showRecent !== false
  let isCompacting = false

  on('session.start', ($, e, next) =>
    $.tool
      .register({
        name: 'note',
        description: NOTE_DESCRIPTION,
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            text: { type: 'string' },
            replaces: { type: 'integer', minimum: 1 },
          },
          required: ['kind', 'text'],
        },
      })
      .then(() =>
        $.command.register({
          name: 'ledgers',
          description: 'Find earlier sessions by keyword, or load one\'s notes: /ledgers [word] | /ledgers load <id>',
          argumentHint: '[word] | load <id>',
        })
      )
      .then(async () => {
        sessionCwd = e.cwd
        if (showRecent && e.isInteractive) {
          const id = await $.session.id()
          recentText = await recentSection($, id, e.cwd).catch(() => '')
        }
      })
      .then(() => next(e))
  )

  on('command.run', { command: 'ledgers' }, ($, e) => ledgersCommand($, e.args))

  on('tool.call', async ($, e, next) => {
    if (e.tool === NOTE_TOOL) {
      const kind = 'kind' in e ? e.kind : undefined
      const text = 'text' in e ? e.text : undefined
      const replaces = 'replaces' in e ? e.replaces : undefined
      if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof text !== 'string' || text.trim() === '') {
        return { isError: true, result: `kind must be one of ${KINDS.join(', ')}, and text non-empty.` }
      }
      const { value: held } = await load($)
      if (replaces === undefined && held.notes.length >= MAX_NOTES) {
        return {
          isError: true,
          result: `The ledger is full (${MAX_NOTES} notes). Merge related or resolved notes into this one by passing replaces: n.`,
        }
      }
      const note: Note = { kind, text: text.trim(), at: new Date().toISOString() }
      let number = 0
      await change($, (v) => {
        // in place, so the numbers the model already holds stay valid
        const at = typeof replaces === 'number' ? replaces - 1 : -1
        if (at >= 0 && at < v.notes.length) {
          number = replaces as number
          return { ...v, notes: v.notes.map((n, i) => (i === at ? note : n)) }
        }
        number = v.notes.length + 1
        return { ...v, notes: [...v.notes, note] }
      })
      return { result: `Noted as #${number}.` }
    }

    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined || result.isError) {
      return result
    }
    const path =
      e.tool === 'Edit' || e.tool === 'Write'
        ? e.file_path
        : e.tool === 'NotebookEdit'
          ? e.notebook_path
          : undefined
    if (path !== undefined) {
      await change($, (v) =>
        v.files.includes(path) ? v : { ...v, files: [...v.files, path].slice(-MAX_FILES) }
      ).catch(() => undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next({ ...e, instructions: buildInstructions({ focus: e.instructions }) })
    }
    const result = await next({
      ...e,
      instructions: await mainInstructions($, e.instructions),
    })
    if (e.trigger !== 'precompute') {
      await recordCompaction($, result, maxTokens)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta) {
      return next(e)
    }
    const { value } = await load($)
    return next({ ...e, context: [...(e.context ?? []), nudgeText(value.notes.length)] })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { value } = await load($)
    const recent = recentText === '' ? [] : [{ id: 'context-keeper:recent', scope: 'session' as const, text: recentText }]
    if (value.snapshot === '') {
      return recent.length === 0 ? composed : { sections: [...composed.sections, ...recent] }
    }
    // changes only at compaction, which rebuilds the cache anyway
    return {
      sections: [
        ...composed.sections,
        ...recent,
        {
          id: 'context-keeper:ledger',
          scope: 'session' as const,
          text: `Session ledger carried over from before context compaction. It is authoritative: follow its decisions and corrections, and do not re-propose rejected options. Keep it current with the note tool.\n\n${value.snapshot}`,
        },
      ],
    }
  }).catch(($, e, next) => next(e))

  // live status after every model response, not only at the end of a turn
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const u = result.usage
      const tokens =
        u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      try {
        const [{ context }, { value }] = await Promise.all([$.session.usage(), load($)])
        const trigger = Math.min((context.window * percent) / 100, maxTokens)
        $.ui.status(statusText(tokens, trigger, value.notes.length))
      } catch {
        // a status line is never worth failing a model request over
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || isCompacting) {
      return result
    }
    const [{ context }, { value }] = await Promise.all([$.session.usage(), load($)])
    const tokens = context.tokens ?? 0
    const trigger = Math.min((context.window * percent) / 100, maxTokens)
    $.ui.status(statusText(tokens, trigger, value.notes.length))
    if (shouldCompact(tokens, trigger, value.lastCompactTokens)) {
      isCompacting = true
      $.ui.status(`ctx ⟳ compacting ${kTokens(tokens)}…`)
      // compact() rejects while a turn runs, so wait for this one to close.
      // It skips this mod's own session.compact hook, so do that work here.
      $.clock.after(500, () => {
        mainInstructions($, undefined)
          .then((instructions) => $.session.compact({ instructions }))
          .then(async (r) => {
            await recordCompaction($, r, maxTokens)
            return r
          })
          .then((r) =>
            $.ui.status(
              r.skip === undefined
                ? `ctx ✓ compacted ${kTokens(tokens)} → ${r.tokensAfter ? kTokens(r.tokensAfter) : '?'} · next at ${kTokens(trigger)}`
                : `ctx ✗ compaction skipped: ${r.skip}`
            )
          )
          .catch(() => undefined)
          .finally(() => {
            isCompacting = false
          })
      })
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    const held = await $.state.get({ ...ledger, id: e.sessionId })
    if (held.value) {
      await persist($, e.sessionId, held.value)
    }
    // /clear goes on under a new session id with an empty ledger, but the
    // status line keeps the old one's figures until the next model response
    if (e.reason === 'clear') {
      const { context } = await $.session.usage()
      $.ui.status(statusText(0, Math.min((context.window * percent) / 100, maxTokens), 0))
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
