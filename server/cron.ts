import type { ScheduledTask } from 'node-cron'

const globalTaskState = globalThis as typeof globalThis & {
  __kunGalgameTasksStarted?: boolean
  __kunGalgameTasksStarting?: Promise<void>
}

const getKUNGalgameTasks = async (): Promise<ScheduledTask[]> => {
  const [
    { resetDailyTask },
    { flushPatchViewsTask },
    { moderationTask },
    { searchOutboxTask },
    { searchCountsRefreshTask },
    { searchReconcileTask },
    { s3DeletionOutboxTask }
  ] = await Promise.all([
    import('./tasks/resetDailyTask'),
    import('./tasks/flushPatchViewsTask'),
    import('./tasks/moderationTask'),
    import('./tasks/searchOutboxTask'),
    import('./tasks/searchCountsRefreshTask'),
    import('./tasks/searchReconcileTask'),
    import('./tasks/s3DeletionOutboxTask')
  ])

  return [
    resetDailyTask,
    flushPatchViewsTask,
    moderationTask,
    searchOutboxTask,
    searchCountsRefreshTask,
    searchReconcileTask,
    s3DeletionOutboxTask
  ]
}

export const setKUNGalgameTask = async () => {
  if (globalTaskState.__kunGalgameTasksStarted) {
    return
  }

  if (globalTaskState.__kunGalgameTasksStarting) {
    await globalTaskState.__kunGalgameTasksStarting
    return
  }

  const startingTask = (async () => {
    const tasks = await getKUNGalgameTasks()
    await Promise.all(tasks.map((task) => task.start()))
    globalTaskState.__kunGalgameTasksStarted = true
  })()

  globalTaskState.__kunGalgameTasksStarting = startingTask

  try {
    await startingTask
  } catch (error) {
    globalTaskState.__kunGalgameTasksStarted = false
    throw error
  } finally {
    if (globalTaskState.__kunGalgameTasksStarting === startingTask) {
      globalTaskState.__kunGalgameTasksStarting = undefined
    }
  }
}
