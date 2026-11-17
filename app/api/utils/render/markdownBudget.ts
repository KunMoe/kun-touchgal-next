// 渲染预算: 解析后的结构上限与解析前的成本熔断。纯函数, 无依赖。
//
// 这里的常量属于渲染策略: 改动任何一个都会改变哪些内容被降级或拒收, 与改 sanitize
// 策略一样要递增对应 profile 的 HTML 版本并回填 (见 sanitizeSchema.ts 头注释)

// 权威结构上限, 作用在解析后的真实 mdast 上: 约 63 层列表或 126 层引用
export const MARKDOWN_MAX_TREE_DEPTH = 128

// 以下两项只是成本熔断, 不承担正确性: 同一行的容器标记会让解析耗时随嵌套深度叠加,
// 再深会在解析期栈溢出。漏判的输入仍由结构上限与入口的 catch 兜住, 只是要先付一次
// 解析成本。容器指令 (`:::名字`) 曾是第三项: 指令方言不再解析它 (见
// utils/markdown/kunDialect.ts), 那种写法现在只是普通文字, 不会嵌套
export const MARKDOWN_MAX_LINE_CONTAINER_MARKERS = 256
// 解析器每遇到一个 ] 都要在本段已有的内容里回找与它配对的 [, 配上的图片还要把里层
// 重新整理一遍: 一段里的方括号一多, 耗时按平方增长 (1 万字符的嵌套图片或一串 ] 约 1 秒,
// 而得到的树只有两层, 结构上限看不到)。真实内容里一段最多 32 个
export const MARKDOWN_MAX_PARAGRAPH_BRACKETS = 1024

const TAB = 9
const LF = 10
const CR = 13
const SPACE = 32
const PAREN_CLOSE = 41
const ASTERISK = 42
const PLUS = 43
const DASH = 45
const DOT = 46
const DIGIT_0 = 48
const DIGIT_9 = 57
const GREATER_THAN = 62
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93
const UNDERSCORE = 95
const BOM = 0xfeff

const isBlank = (code: number) => code === SPACE || code === TAB
const isDigit = (code: number) => code >= DIGIT_0 && code <= DIGIT_9

export interface MarkdownCost {
  // 单行行首连续的容器标记 (引用 `>`、列表 `-` `*` `+` `1.`) 个数的最大值
  maxLineContainerMarkers: number
  // 同一段 (空行分隔) 内 `[` 个数与 `]` 个数中较大者的最大值
  maxParagraphBrackets: number
}

// 单遍线性扫描, 不解析。它只可能多数、不能少数: 少数一行, 熔断就被绕过。所以
//   - 行的切分与解析器一致: \n、\r\n、孤立的 \r 都结束一行, 文档开头的 BOM 不算行首字符;
//   - 围栏代码内的行照数不误: 一行是不是围栏取决于它所在的容器与 HTML 块, 扫描器
//     判断不了 (列表里的围栏随列表结束而关闭), 认错一次, 其后的行就全部漏数;
//   - 方括号只数个数、不配对: 行内代码与 HTML 标签里的 ] 解析器不当闭合, 遇 ] 就减
//     的深度计数可以被它们压回去。行内内容不跨空行, 所以按空行分段各数各的。
// 余下整段是分隔线 (`- - -`、`* * *`) 时不是列表, 每行只从行尾回看一次来判定 ——
// 对每个标记都向后判一次会退化成 O(n²)
export const measureMarkdownCost = (markdown: string): MarkdownCost => {
  const length = markdown.length
  let maxLineContainerMarkers = 0
  let maxParagraphBrackets = 0
  let openBrackets = 0
  let closeBrackets = 0

  for (
    let lineStart = markdown.charCodeAt(0) === BOM ? 1 : 0;
    lineStart <= length;
  ) {
    const start = lineStart
    let end = start
    let blankLine = true
    while (end < length) {
      const code = markdown.charCodeAt(end)
      if (code === LF || code === CR) {
        break
      }
      if (code === BRACKET_OPEN) {
        openBrackets++
      } else if (code === BRACKET_CLOSE) {
        closeBrackets++
      }
      if (blankLine && !isBlank(code)) {
        blankLine = false
      }
      end++
    }
    if (blankLine) {
      openBrackets = 0
      closeBrackets = 0
    } else if (Math.max(openBrackets, closeBrackets) > maxParagraphBrackets) {
      maxParagraphBrackets = Math.max(openBrackets, closeBrackets)
    }
    lineStart =
      markdown.charCodeAt(end) === CR && markdown.charCodeAt(end + 1) === LF
        ? end + 2
        : end + 1

    // 行尾那段只由空白与同一个 - * _ 组成的区间 [uniformStart, end), 以及其中倒数
    // 第三个该字符的位置: 从这两者之间任一位置起, 余下整段都是分隔线
    let thematicReady = false
    let uniformStart = end
    let thirdFromEnd = -1
    const isThematicFrom = (index: number) => {
      if (!thematicReady) {
        thematicReady = true
        let back = end - 1
        while (back >= start && isBlank(markdown.charCodeAt(back))) {
          back--
        }
        const marker = back >= start ? markdown.charCodeAt(back) : 0
        if (marker === DASH || marker === ASTERISK || marker === UNDERSCORE) {
          let count = 0
          while (back >= start) {
            const code = markdown.charCodeAt(back)
            if (code === marker) {
              count++
              if (count === 3) {
                thirdFromEnd = back
              }
            } else if (!isBlank(code)) {
              break
            }
            back--
          }
          uniformStart = back + 1
        }
      }
      return index >= uniformStart && index <= thirdFromEnd
    }

    let index = start
    let markers = 0
    while (index < end) {
      const code = markdown.charCodeAt(index)
      if (isBlank(code)) {
        index++
        continue
      }
      if (code === GREATER_THAN) {
        markers++
        index++
        continue
      }
      if (code === DASH || code === ASTERISK || code === PLUS) {
        const after = index + 1
        if (after < end && !isBlank(markdown.charCodeAt(after))) {
          break
        }
        if (code !== PLUS && isThematicFrom(index)) {
          break
        }
        markers++
        index = after
        continue
      }
      if (isDigit(code)) {
        let digitsEnd = index + 1
        while (
          digitsEnd < end &&
          digitsEnd - index < 9 &&
          isDigit(markdown.charCodeAt(digitsEnd))
        ) {
          digitsEnd++
        }
        const delimiter = markdown.charCodeAt(digitsEnd)
        const after = digitsEnd + 1
        if (
          digitsEnd < end &&
          (delimiter === DOT || delimiter === PAREN_CLOSE) &&
          (after >= end || isBlank(markdown.charCodeAt(after)))
        ) {
          markers++
          index = after
          continue
        }
      }
      break
    }
    if (markers > maxLineContainerMarkers) {
      maxLineContainerMarkers = markers
    }
  }

  return { maxLineContainerMarkers, maxParagraphBrackets }
}

export const exceedsCostFuse = (markdown: string): boolean => {
  const cost = measureMarkdownCost(markdown)
  return (
    cost.maxLineContainerMarkers > MARKDOWN_MAX_LINE_CONTAINER_MARKERS ||
    cost.maxParagraphBrackets > MARKDOWN_MAX_PARAGRAPH_BRACKETS
  )
}

type TreeNode = { children?: unknown[] }

// 根节点深度为 0。显式栈迭代: 被测的树可能深到足以让递归遍历自己栈溢出
export const measureTreeDepth = (root: TreeNode): number => {
  let maxDepth = 0
  const nodes: TreeNode[] = [root]
  const depths: number[] = [0]
  while (nodes.length > 0) {
    const node = nodes.pop() as TreeNode
    const depth = depths.pop() as number
    if (depth > maxDepth) {
      maxDepth = depth
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        nodes.push(child as TreeNode)
        depths.push(depth + 1)
      }
    }
  }
  return maxDepth
}

export const treeDepthExceeds = (root: TreeNode, max: number): boolean =>
  measureTreeDepth(root) > max
