import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80 },
} as const

test('a todo list shows objective, current task, percent and counts', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'Fix the login bug.', usage: {} },
  }))
  on('tool.call', () => ({ result: {} }))

  await $.prompt.submit({ text: 'please fix the login bug where users get logged out' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Reproduce', status: 'completed', activeForm: 'Reproducing' },
      { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
      { content: 'Test', status: 'pending', activeForm: 'Testing' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Fix the login bug$/ }))?.text).toBe(
      '◆ Fix the login bug',
    )
    expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe('25%  1/4')
    expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('▸ Fix it  then Test')
    expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toBe('✓ 1 done  ○ 3 left')
    await ui.unmount()
  }
})

test('the report tool sets objective and tasks, and rejects bad input', async $ => {
  const bad = await $.tool.call({ tool: 'mcp__progress__report', objective: 'x', tasks: [] })
  expect(bad.isError).toBe(true)

  await $.tool.call({
    tool: 'mcp__progress__report',
    objective: 'Ship the progress mod',
    tasks: [
      { subject: 'Design', status: 'completed' },
      { subject: 'Build', status: 'completed' },
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Ship/ }))?.text).toBe('◆ Ship the progress mod')
  expect((await ui.find({ type: 'Text', text: /complete/ }))?.text).toBe('All tasks complete')
  await ui.unmount()
})
