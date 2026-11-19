import { ALLOWED_EXTENSIONS } from '~/constants/resource'
import { stripInvisible } from '~/utils/text/unicode'

// 资源对象的命名策略, 只有这一份: 服务端建暂存对象 (server/storage/stagedUpload) 与上传界面
// 的预检、展示都调它。结果要么是「清洗后的主名 + 白名单里的扩展名」, 要么是 null ——
// 洗不出可用的名字就拒绝, 不把原文放行

const MAX_BASE_NAME_CODE_POINTS = 100

export const UNSAFE_OBJECT_NAME_ERROR = `文件名不可用: 仅支持 ${ALLOWED_EXTENSIONS.join(' ')} 格式, 且文件名需要包含文字或数字, 请改名后重新上传`

export const toSafeObjectName = (raw: string): string | null => {
  // 先剥掉不参与命名的码点: 不可见码点、控制符 (含 LF、CR)、行与段分隔符,
  // 让它们影响不到扩展名的判定
  const name = stripInvisible(raw).replace(/[\p{Cc}\u2028\u2029]/gu, '')

  const dot = name.lastIndexOf('.')
  const extension = name.slice(dot).toLowerCase()
  if (dot === -1 || !ALLOWED_EXTENSIONS.includes(extension)) {
    return null
  }

  // 主名过白名单之后做规范合成 (NFC, 不是兼容合成)。macOS 交来的文件名是分解形式, 浊点与
  // 重音是独立的组合符号: 白名单留下它们, 合成把它们并回基字。合成放在过滤之后, 因为夹在
  // 基字与组合符号之间的字符滤掉了二者才相邻; 结果因此恒为合成形式, 再过一遍本函数不变。
  // 最后按码点截断, 切点不会落在代理对中间 (孤立代理不在白名单里, 已经滤掉)
  const baseName = [
    ...name
      .slice(0, dot)
      .replace(/[^\p{L}\p{M}\p{N}_-]/gu, '')
      .normalize('NFC')
  ]
    .slice(0, MAX_BASE_NAME_CODE_POINTS)
    .join('')
  // 只剩组合符号、下划线或连字符的主名 (整个名字都是 emoji 时留下的残片) 同样算空
  if (!/[\p{L}\p{N}]/u.test(baseName)) {
    return null
  }

  return `${baseName}${extension}`
}
