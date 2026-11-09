import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status, Task } from '../types'

const tasks = atom({ plugin: 'progress', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const objective = atom({ plugin: 'progress', key: 'objective' } as const, '')

const REPORT = 'mcp__progress__report'
const STATUSES: readonly Status[] = ['pending', 'in_progress', 'completed']

const isFinished = (list: readonly Task[]) => list.every(t => t.status === 'completed')
const clip = (text: string, max: number) =>
  max <= 1 ? '' : text.length <= max ? text : `${text.slice(0, max - 1)}…`

let lastPrompt = ''

// A list starting from nothing (or from an all-done list) is a new objective.
async function replace($: EngineInterface, next: Task[]) {
  const before = await read($, tasks)
  await update($, tasks, () => next)
  if (next.length > 0 && isFinished(before) && lastPrompt) {
    const prompt = lastPrompt
    await update($, objective, () => (prompt.split('\n')[0] ?? '').slice(0, 70))
    const r = await $.model.complete({
      model: 'haiku',
      maxTokens: 30,
      prompt: `Summarise this request as an objective in at most 8 words. Reply with the objective only.\n\n<request>${prompt.slice(0, 4000)}</request>`,
    })
    if (r.isAnswered) await update($, objective, () => r.text.trim().replace(/^["']|["'.]$/g, ''))
  }
}

function toTasks(value: unknown): Task[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'tasks must be a non-empty array'
  const out: Task[] = []
  for (const [i, item] of value.entries()) {
    const subject: unknown = item?.subject
    const status: unknown = item?.status
    const match = STATUSES.find(s => s === status)
    if (typeof subject !== 'string' || subject === '' || !match) {
      return `tasks[${i}] needs a subject and a status (${STATUSES.join(' | ')})`
    }
    out.push({ id: String(i), subject, status: match })
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'report',
      isDeferred: false,
      description:
        'Show the user a progress band above the prompt. Call it whenever you start multi-step work (3+ steps) and again each time a step starts or finishes. Send the whole list every time; exactly one task in_progress while working.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The overall goal, at most 8 words' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Short imperative step, e.g. "Run the tests"' },
                status: { type: 'string', enum: STATUSES },
              },
              required: ['subject', 'status'],
            },
          },
        },
        required: ['objective', 'tasks'],
      },
    })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) {
      lastPrompt = e.text
      // A finished list stays up until the next prompt.
      if (isFinished(await read($, tasks))) await update($, tasks, () => [])
    }
    return next(e)
  })

  on('tool.call', { tool: REPORT }, async ($, e) => {
    const input: Record<string, unknown> = { ...e }
    const list = toTasks(input.tasks)
    if (typeof list === 'string') return { result: list, isError: true }
    const goal = typeof input.objective === 'string' ? input.objective.trim() : ''
    await update($, tasks, () => list)
    if (goal) await update($, objective, () => goal)
    const done = list.filter(t => t.status === 'completed').length
    return { result: `Progress shown: ${done}/${list.length} done.` }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (!('deny' in ran && ran.deny) && !ran.isError) {
      await replace(
        $,
        e.todos.map((t, i) => ({ id: String(i), subject: t.content, status: t.status })),
      )
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result && !ran.isError) {
      const created: Task = { id: ran.result.task.id, subject: e.subject, status: 'pending' }
      const list = await read($, tasks)
      await replace($, [...(isFinished(list) ? [] : list), created])
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result && !ran.isError) {
      const { taskId, status, subject } = e
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(t => t.id !== taskId)
          : list.map(t =>
              t.id === taskId ? { ...t, status: status ?? t.status, subject: subject ?? t.subject } : t,
            ),
      )
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const total = list.length
    const done = list.filter(t => t.status === 'completed').length
    const left = total - done
    const pct = Math.round((done / total) * 100)
    const isDone = left === 0
    const active = list.find(t => t.status === 'in_progress')
    const upNext = list.find(t => t.status === 'pending')
    const accent = isDone ? 'success' : 'claude'

    // Border (2) + padding (2) eat four columns.
    const inner = Math.max(20, e.props.bodyColumns - 4)
    const stats = `${pct}%  ${done}/${total}`
    const goal = clip((await read($, objective)) || 'Progress', inner - stats.length - 4)
    const filled = Math.round((done / total) * inner)

    const counts = `✓ ${done} done  ○ ${left} left`
    const current = isDone
      ? 'All tasks complete'
      : active
        ? `▸ ${active.subject}`
        : upNext
          ? `○ Up next: ${upNext.subject}`
          : ''
    const after = active && upNext ? `  then ${upNext.subject}` : ''
    const room = inner - counts.length - 2
    const shown = clip(current, room)
    const tail = clip(after, room - shown.length)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>
            <Text color={accent}>◆ </Text>
            {goal}
          </Text>
          <Text>
            <Text bold color={accent}>
              {pct}%
            </Text>
            <Text dimColor>  {done}/{total}</Text>
          </Text>
        </Box>
        <Text>
          <Text color={accent}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(inner - filled)}</Text>
        </Text>
        <Box justifyContent="space-between">
          <Text>
            <Text color={isDone ? 'success' : active ? 'text' : 'subtle'} bold={!!active || isDone}>
              {shown}
            </Text>
            <Text dimColor>{tail}</Text>
          </Text>
          <Text>
            <Text color="success">✓ {done}</Text>
            <Text dimColor> done  </Text>
            <Text color="subtle">○ {left}</Text>
            <Text dimColor> left</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
