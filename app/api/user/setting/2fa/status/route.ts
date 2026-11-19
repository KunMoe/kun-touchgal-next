import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'

const get2FAStatus = async (uid?: number) => {
  if (!uid) {
    return { enabled: false, hasSecret: false }
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      enable_2fa: true,
      two_factor_secret: true,
      two_factor_backup: true
    }
  })

  return {
    enabled: user?.enable_2fa || false,
    hasSecret: !!user?.two_factor_secret,
    backupCodeLength: user?.two_factor_backup
      ? user.two_factor_backup.length
      : 0
  }
}

export const GET = kunRoute.get({
  auth: 'optional',
  handler: async ({ actor: payload }) => get2FAStatus(payload?.uid)
})
