import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { incrementPatchViewBuffer } from './buffer'

const logPatchViewError = (message: string, error: unknown) => {
  kunLog('patch.views_failed', { op: message }, error)
}

export const updatePatchViews = async (uniqueId: string) => {
  try {
    await incrementPatchViewBuffer(uniqueId)
    return
  } catch (error) {
    logPatchViewError('Failed to buffer patch view increment:', error)
  }

  try {
    await prisma.patch.updateMany({
      where: { unique_id: uniqueId },
      data: { view: { increment: 1 } }
    })
  } catch (error) {
    logPatchViewError('Failed to update patch views in DB:', error)
  }
}
