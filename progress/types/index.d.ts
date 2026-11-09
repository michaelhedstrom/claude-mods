export type Status = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; subject: string; status: Status }

declare module 'claude-code' {
  interface PluginState {
    progress: { tasks: Shaped<Task[]>; objective: string }
  }
}
