export type Task = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

declare module 'claude-code' {
  interface PluginState {
    'task-tracker': { tasks: Shaped<Task[]> }
  }
}
