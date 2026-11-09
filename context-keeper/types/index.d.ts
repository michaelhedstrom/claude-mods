export type Note = { kind: string; text: string; at: string }

export type Ledger = {
  notes: Note[]
  files: string[]
  snapshot: string
  lastCompactTokens: number
  // absent on ledgers written before 0.4.0
  cwd?: string
  keywords?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-keeper': { ledger: StateFamily<Ledger> }
  }
}
