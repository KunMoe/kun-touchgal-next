// 不可见码点取 \p{Cf} 与 Default_Ignorable_Code_Point 的并集, 只取任一侧都会漏:
// U+FFF9 (行间注释锚点) 等 32 个码点只属于 Cf; U+3164 (韩文填充符)、U+034F (CGJ)
// 只属于 Default_Ignorable。NFKC 不会把可见字符变成不可见字符, 所以先剥再归一即可
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

// 只用于比较与判空, 不用于展示: 变体选择符与 ZWJ 也在集合内, emoji 序列会被拆散
export const stripInvisible = (text: string) => text.replace(INVISIBLE_RE, '')

// 按码点而非 UTF-16 码元截断, 切点不会落在代理对中间; 输入里原有的孤立代理替换为
// U+FFFD, 所以结果恒为 well-formed, 可以安全写进 jsonb (Postgres 拒收孤立代理)
export const sliceCodePoints = (text: string, max: number) => {
  let end = 0
  for (let count = 0; count < max && end < text.length; count++) {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1
  }
  return text.slice(0, end).toWellFormed()
}
