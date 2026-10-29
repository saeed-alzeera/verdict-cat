import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'

const PANE = 'task-tracker'
const tasks = atom({ plugin: 'task-tracker', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})

const ICON = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-pane',
      description: 'Show the to-do list Claude is working through in a pane',
    })
    // opened unasked, so a surface may hold it back (narrow window, no pane support): say so instead of failing silently
    const opened = await $.ui.open({ id: PANE, title: 'Tasks' })
    if (!opened.isPlaced) $.ui.toast(`Tasks pane not shown (${opened.reason}). Run /task-pane to open it.`)

    return next(e)
  })

  on('command.run', { command: 'task-pane' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Tasks' })

    return {
      text: opened.isPlaced
        ? 'Tasks pane opened.'
        : `Tasks pane is open but not drawn: ${opened.reason}`,
    }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    await update($, tasks, () =>
      e.todos.map((t, i) => ({
        id: String(i),
        text: t.content,
        status: t.status,
        activeForm: t.activeForm,
      })),
    )

    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && !ran.isError ? ran.result?.task?.id : undefined
    if (id) {
      await update($, tasks, list => [
        ...list.filter(t => t.id !== id),
        { id, text: e.subject, status: 'pending', activeForm: e.activeForm },
      ])
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await update($, tasks, list =>
        e.status === 'deleted'
          ? list.filter(t => t.id !== e.taskId)
          : list.map(t =>
              t.id === e.taskId
                ? {
                    ...t,
                    text: e.subject ?? t.text,
                    status: e.status ?? t.status,
                    activeForm: e.activeForm ?? t.activeForm,
                  }
                : t,
            ),
      )
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, tasks)
    const done = list.filter(t => t.status === 'completed').length
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No tasks yet.</Text>}
        {list.length > 0 && (
          <Text bold>
            {done}/{list.length} done
          </Text>
        )}
        {list.slice(0, room).map(t => (
          <Text
            dimColor={t.status === 'completed'}
            bold={t.status === 'in_progress'}
          >
            {ICON[t.status]}{' '}
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.text}
          </Text>
        ))}
      </Box>
    )
  })
}
