import { createHmac } from 'crypto'
import { prisma } from '~/prisma/index'

const BACKUP_CODE_HASH_PREFIX = 'h1:'

type TwoFactorBackupCodeDB = Pick<typeof prisma, '$executeRaw'>

const getBackupCodePepper = () => {
  const pepper = process.env.KUN_TWO_FACTOR_BACKUP_PEPPER
  if (!pepper) {
    throw new Error('KUN_TWO_FACTOR_BACKUP_PEPPER is not configured')
  }
  return pepper
}

export const isHashedTwoFactorBackupCode = (code: string) =>
  code.startsWith(BACKUP_CODE_HASH_PREFIX)

export const hashTwoFactorBackupCode = (code: string) =>
  `${BACKUP_CODE_HASH_PREFIX}${createHmac('sha256', getBackupCodePepper())
    .update(code)
    .digest('hex')}`

export const consumeTwoFactorBackupCode = async (
  uid: number,
  token: string,
  db: TwoFactorBackupCodeDB = prisma
) => {
  const hashedToken = hashTwoFactorBackupCode(token)
  const affected = await db.$executeRaw`
    UPDATE "user"
    SET two_factor_backup = array_remove(
      array_remove(two_factor_backup, ${token}),
      ${hashedToken}
    )
    WHERE id = ${uid}
      AND enable_2fa = true
      AND (
        ${token} = ANY(two_factor_backup)
        OR ${hashedToken} = ANY(two_factor_backup)
      )
  `
  return affected === 1
}
