// 不可见码点取 \p{Cf} 与 Default_Ignorable_Code_Point 的并集, 只取任一侧都会漏:
// U+FFF9 (行间注释锚点) 等 32 个码点只属于 Cf; U+3164 (韩文填充符)、U+034F (CGJ)
// 只属于 Default_Ignorable。NFKC 不会把可见字符变成不可见字符, 所以先剥再归一即可
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

// 只用于比较与判空, 不用于展示: 变体选择符与 ZWJ 也在集合内, emoji 序列会被拆散;
// Cf 里还有少数带字形的前置连接符 (如阿拉伯数字符号 U+0600), 同样会被剥掉
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

// u 模式下成对的代理是一个码点, 只有孤立的才属于 Cs
const LONE_SURROGATE_RE = /\p{Cs}/u

// 能原样交给严格下游的文本: 没有 NUL (PG 的文本参数拒收 0x00, 报 22021), 没有孤立代理
// (Meilisearch 判请求体不是合法 JSON, PG 的 jsonb 同样拒收)。客户端也会用到, 所以不用
// String.prototype.isWellFormed
export const isWellFormedText = (text: string) =>
  !text.includes('\u0000') && !LONE_SURROGATE_RE.test(text)

// 写进 jsonb 之前的最后一道: 深度遍历, 把每个字符串叶子里的孤立代理替换为 U+FFFD, 与写 varchar
// 时驱动的做法一致 (Prisma 先 JSON.stringify, 孤立代理成了 "\ud800" 转义, PG 解析 jsonb 时拒收,
// 整个事务失败)。只进普通对象与数组, 其余值原样返回; 键来自 schema, 不处理
export const toWellFormedDeep = <T>(value: T): T => {
  if (typeof value === 'string') {
    return value.toWellFormed() as T
  }
  if (Array.isArray(value)) {
    return value.map(toWellFormedDeep) as T
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          toWellFormedDeep(item)
        ])
      ) as T
    }
  }
  return value
}
