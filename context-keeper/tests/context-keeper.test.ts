import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOTE = 'mcp__context-keeper__note'
const MSG: SessionMessage = { role: 'user', text: 'fix the auth bug', toolUses: [] }

const world = (on: On, session = { id: 's1', tokens: 0 }, files: Record<string, string> = {}) => {
  const compactions: (string | undefined)[] = []
  const writes: Record<string, string> = { ...files }
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: session.id }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: NOTE } }))
  on('tool.call', () => ({ result: {} }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({
    value: Object.keys(writes)
      .filter((p) => p.startsWith('/home/u/.claude/context-keeper/'))
      .map((p) => ({ name: p.split('/').at(-1) ?? '', kind: 'file' as const, size: 1, mtimeMs: Date.parse('2026-11-01'), isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const text = writes[e.path]
    if (text === undefined) {
      throw new Error('ENOENT')
    }
    return { value: text }
  })
  on('fs.write', (_, e) => {
    writes[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('status') ? '## feat/x\n M a.ts' : 'abc1234 wip',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: session.tokens, window: 1_000_000 },
      rateLimits: [],
      cost: { usd: 0 },
    },
  }))
  on('session.compact', (_, e) => {
    compactions.push(e.instructions)
    return {
      messages: [{ role: 'assistant', text: 'the summary', toolUses: [] }],
      tokensAfter: 40_000,
    }
  })
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'base', scope: 'shared' }],
  }))
  on('turn.complete', () => ({ text: '' }))
  return { compactions, writes, session }
}

const COMPOSE = {
  model: 'm',
  promptModel: 'm',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test('should hand the summarizer focus, checklist, notes, files and git', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'local queue, broker rejected: low volume' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'y', new_string: 'z' })
  await $.session.compact({ trigger: 'manual', instructions: 'the auth bug', messages: [MSG] })

  const text = w.compactions[0]
  expect(text).toContain("User's focus for this compaction: the auth bug")
  expect(text).toContain('alternatives rejected, and why')
  expect(text).toContain('#1 [decision] local queue, broker rejected: low volume')
  expect(text?.match(/\/repo\/a\.ts/g)?.length).toBe(1)
  expect(text).toContain('## feat/x')
  expect(w.writes['/home/u/.claude/context-keeper/s1-summary.md']).toBe('the summary')
})

test('should re-inject the ledger only after a compaction', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'correction', text: '"never push to main"' })

  const before = await $.prompt.compose(COMPOSE)
  expect(before.sections.some((s) => s.id === 'context-keeper:ledger')).toBe(false)

  await $.session.compact({ trigger: 'auto', messages: [MSG] })
  const after = await $.prompt.compose(COMPOSE)
  const section = after.sections.find((s) => s.id === 'context-keeper:ledger')
  expect(section?.text).toContain('#1 [correction] "never push to main"')
})

test('should drop a note it replaces', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'open', text: 'which port?' })
  await $.tool.call({ tool: NOTE, kind: 'constraint', text: 'port 5441, 5433 taken', replaces: 1 })
  await $.session.compact({ trigger: 'manual', messages: [MSG] })

  expect(w.compactions[0]).not.toContain('which port?')
  expect(w.compactions[0]).toContain('#1 [constraint] port 5441')
})

test('should reject a malformed note', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await $.tool.call({ tool: NOTE, kind: 'whatever', text: 'x' })

  expect(result.isError).toBe(true)
})

test('should start an empty ledger in a new session (after /clear)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'old session decision' })
  w.session.id = 's2'
  await $.session.compact({ trigger: 'manual', messages: [MSG] })

  expect(w.compactions[0]).not.toContain('old session decision')
})

test('should auto-compact at the token cap, then wait for real growth', async ($, on) => {
  const w = world(on, { id: 's1', tokens: 410_000 })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'keep it' })

  await $.turn.complete(turn)
  await clock.advance(1000)
  expect(w.compactions.length).toBe(1)
  // the mod's own session.compact hook is skipped for a compaction it starts
  expect(w.compactions[0]).toContain('alternatives rejected, and why')
  expect(w.writes['/home/u/.claude/context-keeper/s1-summary.md']).toBe('the summary')
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.some((s) => s.id === 'context-keeper:ledger')).toBe(true)

  // baseline after compaction is 40k; 410k is past 40k + 400k/4, so it may compact
  // again, but 70k is not
  w.session.tokens = 70_000
  await $.turn.complete(turn)
  await clock.advance(1000)
  expect(w.compactions.length).toBe(1)
})

test('should update the status after each model response mid-turn', async ($, on) => {
  world(on, { id: 's1', tokens: 0 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        model: 'm',
        input_tokens: 2_000,
        output_tokens: 10,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 3_000,
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }

  expect(statuses.at(-1)).toBe('ctx ▰▰▰▱▱▱▱▱▱▱ 105k/400k · 295k left')
})

test('should reset the status line to an empty ledger on /clear', async ($, on) => {
  world(on, { id: 's1', tokens: 120_000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'keep it' })
  await $.turn.complete(turn)
  expect(statuses.at(-1)).toContain('✎ 1')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  expect(statuses.at(-1)).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0k/400k · 400k left')
})

test('should leave the status line alone when the session ends for good', async ($, on) => {
  world(on, { id: 's1', tokens: 120_000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)
  const before = statuses.length

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })

  expect(statuses.length).toBe(before)
})

test('should refuse a new note when the ledger is full, but accept a merge', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 60; i++) {
    await $.tool.call({ tool: NOTE, kind: 'decision', text: `d${i}` })
  }

  const full = await $.tool.call({ tool: NOTE, kind: 'decision', text: 'one more' })
  const merged = await $.tool.call({ tool: NOTE, kind: 'decision', text: 'd0+d1', replaces: 1 })

  expect(full.isError).toBe(true)
  expect(merged.isError).not.toBe(true)
})

test('should persist a touched file to disk right away', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: 'x' })

  expect(w.writes['/home/u/.claude/context-keeper/s1.json']).toContain('/repo/b.ts')
})

test('should nudge each typed prompt with the note count, but not a command', async ($, on) => {
  world(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'keep it' })

  await $.prompt.submit({ text: 'next step', wait: false, origin: { kind: 'composer' } })
  expect(seen[0]?.at(-1)).toContain('the ledger holds 1 note.')
  expect(seen[0]?.at(-1)).toContain('replaces: n')
})

test('should keep note numbers stable when one is replaced', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'open', text: 'which port?' })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'use postgres' })
  const r = await $.tool.call({ tool: NOTE, kind: 'constraint', text: 'port 5441', replaces: 1 })
  await $.session.compact({ trigger: 'manual', messages: [MSG] })

  expect(r.result).toBe('Noted as #1.')
  expect(w.compactions[0]).toContain('#1 [constraint] port 5441')
  expect(w.compactions[0]).toContain('#2 [decision] use postgres')
})

test('should reconcile the notes against the summary at compaction', async ($, on) => {
  world(on)
  on('model.complete', (_, e) => {
    expect(e.prompt).toContain('- [open] which port?')
    expect(e.prompt).toContain('the summary')
    return { value: {
      isAnswered: true,
      text: '[{"kind":"constraint","text":"port 5441, 5433 taken"},{"kind":"correction","text":"\\"never push to main\\""}]',
      usage: { model: 'sonnet', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'open', text: 'which port?' })
  await $.session.compact({ trigger: 'auto', messages: [MSG] })

  const composed = await $.prompt.compose(COMPOSE)
  const ledgerText = composed.sections.find((s) => s.id === 'context-keeper:ledger')?.text
  expect(ledgerText).toContain('#1 [constraint] port 5441, 5433 taken')
  expect(ledgerText).toContain('#2 [correction] "never push to main"')
  expect(ledgerText).not.toContain('which port?')
})

test('should keep the notes when the reconciliation reply is malformed', async ($, on) => {
  world(on)
  on('model.complete', () => ({ value: {
    isAnswered: true,
    text: '[{"kind":"vibes","text":"x"}]',
    usage: { model: 'sonnet', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'use postgres' })
  await $.session.compact({ trigger: 'auto', messages: [MSG] })

  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find((s) => s.id === 'context-keeper:ledger')?.text).toContain('#1 [decision] use postgres')
})

const DIR = '/home/u/.claude/context-keeper'
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const old = (cwd: string, text: string, keywords?: string[]) =>
  JSON.stringify({ notes: [{ kind: 'decision', text, at: 'x' }], files: [], snapshot: '', lastCompactTokens: 0, cwd, keywords })

test('should find an earlier ledger by keyword and load its notes', async ($, on) => {
  const w = world(on, { id: 's2', tokens: 0 }, {
    [`${DIR}/aaaa1111-old.json`]: old('/repo', 'csv export uses ; and BOM', ['csv', 'export']),
    [`${DIR}/bbbb2222-other.json`]: old('/elsewhere', 'unrelated'),
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const found = await $.command.run({ command: 'ledgers', args: 'EXPORT', ...RUN })
  expect(found.text).toContain('aaaa1111')
  expect(found.text).toContain('claude --resume aaaa1111-old')
  expect(found.text).not.toContain('bbbb2222')

  const loaded = await $.command.run({ command: 'ledgers', args: 'load aaaa', ...RUN })
  expect(loaded.text).toContain('Loaded 1 notes')
  expect(loaded.context?.[0]).toContain('#1 [decision] csv export uses ; and BOM')
  const saved = JSON.parse(w.writes[`${DIR}/s2.json`] ?? '{}')
  expect(saved.cwd).toBe('/repo')
  expect(saved.notes.length).toBe(1)

  // loading twice adds nothing
  const again = await $.command.run({ command: 'ledgers', args: 'load aaaa', ...RUN })
  expect(again.text).toContain('Loaded 0 notes')
})

test("should list only this project's earlier ledgers in the system prompt", async ($, on) => {
  world(on, { id: 's2', tokens: 0 }, {
    [`${DIR}/aaaa1111-old.json`]: old('/repo', 'csv export uses ; and BOM', ['csv', 'export']),
    [`${DIR}/bbbb2222-other.json`]: old('/elsewhere', 'unrelated'),
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const composed = await $.prompt.compose(COMPOSE)
  const recent = composed.sections.find((s) => s.id === 'context-keeper:recent')?.text
  expect(recent).toContain('csv, export')
  expect(recent).toContain('id aaaa1111-old')
  expect(recent).not.toContain('bbbb2222')
})

test('should store keywords from the reconciliation', async ($, on) => {
  const w = world(on)
  on('model.complete', () => ({ value: {
    isAnswered: true,
    text: '{"keywords":["Auth","refresh"],"notes":[{"kind":"decision","text":"use postgres"}]}',
    usage: { model: 'sonnet', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: NOTE, kind: 'decision', text: 'use postgres' })
  await $.session.compact({ trigger: 'auto', messages: [MSG] })

  expect(JSON.parse(w.writes[`${DIR}/s1.json`] ?? '{}').keywords).toEqual(['auth', 'refresh'])
})
