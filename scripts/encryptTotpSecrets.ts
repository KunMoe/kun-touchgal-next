/* eslint-disable no-console */
import { prisma } from '~/prisma/index'
import { sealLegacyTotpSecrets } from '~/server/auth/twoFactorState'

// 一次性回填: 把存量的明文 TOTP 种子改存密文 (KEK 是 KUN_TWO_FACTOR_SECRET_ENC_KEY)。
// 默认 dry-run 只数不写; 加 --apply 才写库。重复执行无害 (已是密文的行跳过)。
//   pnpm exec esno scripts/encryptTotpSecrets.ts
//   pnpm exec esno scripts/encryptTotpSecrets.ts --apply
// 先决条件: 读密文的版本已在生产稳定运行至少一个发布周期, KEK 已离线备份。那个版本上线之后
// 新绑定的种子就已是密文, 回滚下限从上线起就是它; 回填只是把下限扩到全部 2FA 用户

const apply = process.argv.slice(2).includes('--apply')

const main = async () => {
  const { pending, sealed, changed } = await sealLegacyTotpSecrets({ apply })
  if (apply) {
    console.log(
      `[encrypt-totp] 完成: 明文 ${pending} 个, 已加密 ${sealed} 个, 扫描后被改动而跳过 ${changed} 个`
    )
  } else {
    console.log(
      `[encrypt-totp] dry-run 结束 (未写库): 明文种子 ${pending} 个; 加 --apply 执行`
    )
  }
}

main()
  .catch((error) => {
    console.error('[encrypt-totp] fatal:', error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
