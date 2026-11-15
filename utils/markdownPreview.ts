import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference'
import type { KunSafeHtml } from '~/types/content'

const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 与 micromark 的 characterReference 构造同规: 长度上限 命名 31 / 十进制 7 / 十六进制 6,
// 必须以 ; 收尾, 命名解码失败则整体不算实体
const CHARACTER_REFERENCE_PATTERN =
  /&(?:#(?:[xX]([\da-fA-F]{1,6})|(\d{1,7}))|([\da-zA-Z]{1,31}));/g

// CommonMark 在代码块与代码 span 之外把实体引用解码成字面字符, 服务端管线同此。
// 预览器不解码会双重编码 (AT&amp;T 预览显示 AT&amp;T 而发布显示 AT&T)。
// 必须逐片段解码而非整行预解码: 实体不参与结构判定, &#42;foo&#42; 在服务端是纯文本而非 <em>。
// 解码结果必须无条件再过 escapeHtml, 顺序不可颠倒。
const decodeCharacterReferences = (text: string): string => {
  return text.replace(
    CHARACTER_REFERENCE_PATTERN,
    (whole, hexadecimal, decimal, named) => {
      if (hexadecimal !== undefined) {
        return decodeNumericCharacterReference(hexadecimal, 16)
      }
      if (decimal !== undefined) {
        return decodeNumericCharacterReference(decimal, 10)
      }
      const decoded = decodeNamedCharacterReference(named)
      return decoded === false ? whole : decoded
    }
  )
}

const escapeText = (text: string): string =>
  escapeHtml(decodeCharacterReferences(text))

const INLINE_PATTERN =
  /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~/

// 逐段消费而非链式 replace: 生成的标签不再参与后续匹配, 否则用户文本能借上一条规则
// 生成的引号截断属性 (如 ![a](q[w](x onerror=alert 1 )X) 会把 onerror 注入 img)
const renderInlineMarkdown = (text: string): string => {
  let rest = text
  let html = ''

  while (rest) {
    const match = INLINE_PATTERN.exec(rest)
    if (!match) {
      html += escapeText(rest)
      break
    }

    const groups: (string | undefined)[] = match
    const [, alt, src, linkText, href, code, both, bold, italic, strike] =
      groups

    html += escapeText(rest.slice(0, match.index))

    if (src !== undefined) {
      html += `<img src="${escapeText(src)}" alt="${escapeText(alt ?? '')}" class="max-w-full rounded-lg border border-default-200 my-2" />`
    } else if (href !== undefined) {
      html += `<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(linkText ?? '')}</a>`
    } else if (code !== undefined) {
      // 代码 span 内服务端同样不解码实体, 此处保持 escapeHtml
      html += `<code>${escapeHtml(code)}</code>`
    } else if (both !== undefined) {
      html += `<strong><em>${renderInlineMarkdown(both)}</em></strong>`
    } else if (bold !== undefined) {
      html += `<strong>${renderInlineMarkdown(bold)}</strong>`
    } else if (italic !== undefined) {
      html += `<em>${renderInlineMarkdown(italic)}</em>`
    } else if (strike !== undefined) {
      html += `<del>${renderInlineMarkdown(strike)}</del>`
    }

    rest = rest.slice(match.index + match[0].length)
  }

  return html
}

// GFM 表格里 \| 是转义管道不分隔 cell, \\ 是转义反斜杠 (其后的 | 仍分隔),
// 与 micromark-extension-gfm-table 同规。\| 解码为 | 对齐服务端; \\ 保持原样 —
// 预览器整体不做反斜杠转义, 段落里 \\ 同样显示原样, 只在表格上下文对齐 \|
const splitTableCells = (content: string): string[] => {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]
    if (char === '\\' && (next === '|' || next === '\\')) {
      current += next === '|' ? '|' : '\\\\'
      i++
    } else if (char === '|') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

// 预览器自己逐字符转义后再拼标签, 不经 rehype 管线; 它是 KunSafeHtml 的生产者之一
export const markdownToPreviewHtml = (markdown: string): KunSafeHtml => {
  if (!markdown.trim()) {
    return '<p class="text-default-400 italic">暂无内容</p>' as KunSafeHtml
  }

  const lines = markdown.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeContent = ''
  let codeLanguage = ''
  let inList: 'ul' | 'ol' | null = null
  let inTable = false
  let tableColumnCount = 0

  const flushList = () => {
    if (inList) {
      result.push(`</${inList}>`)
      inList = null
    }
  }

  const flushTable = () => {
    if (inTable) {
      result.push('</tbody></table>')
      inTable = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        result.push(
          `<pre><code>${escapeHtml(codeContent.trimEnd())}</code></pre>`
        )
        codeContent = ''
        codeLanguage = ''
        inCodeBlock = false
      } else {
        flushList()
        flushTable()
        inCodeBlock = true
        codeLanguage = line.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    const tableMatch = line.match(/^\|(.+)\|$/)
    if (inTable && !tableMatch) {
      flushTable()
    }

    if (line.trim() === '') {
      flushList()
      continue
    }

    if (/^>(\s|$)/.test(line)) {
      flushList()
      const quoteParagraphs: string[] = []
      let buffer: string[] = []
      const flushBuffer = () => {
        if (buffer.length) {
          quoteParagraphs.push(
            `<p>${buffer.map(renderInlineMarkdown).join('<br>')}</p>`
          )
          buffer = []
        }
      }
      while (i < lines.length && /^>(\s|$)/.test(lines[i])) {
        const quoteLine = lines[i].replace(/^>\s?/, '')
        if (quoteLine.trim() === '') {
          flushBuffer()
        } else {
          buffer.push(quoteLine)
        }
        i++
      }
      flushBuffer()
      i--
      if (quoteParagraphs.length) {
        result.push(`<blockquote>${quoteParagraphs.join('')}</blockquote>`)
      }
      continue
    }

    if (/^---/.test(line)) {
      flushList()
      result.push('<hr>')
      continue
    }

    const ulMatch = line.match(/^(\s*)[-*] (.+)/)
    if (ulMatch) {
      if (inList !== 'ul') {
        flushList()
        result.push('<ul>')
        inList = 'ul'
      }
      result.push(`<li>${renderInlineMarkdown(ulMatch[2])}</li>`)
      continue
    }

    const olMatch = line.match(/^(\s*)\d+\. (.+)/)
    if (olMatch) {
      if (inList !== 'ol') {
        flushList()
        result.push('<ol>')
        inList = 'ol'
      }
      result.push(`<li>${renderInlineMarkdown(olMatch[2])}</li>`)
      continue
    }

    flushList()

    if (/^###### (.+)/.test(line)) {
      const content = line.replace(/^###### /, '')
      result.push(`<h6>${renderInlineMarkdown(content)}</h6>`)
      continue
    }

    if (/^##### (.+)/.test(line)) {
      const content = line.replace(/^##### /, '')
      result.push(`<h5>${renderInlineMarkdown(content)}</h5>`)
      continue
    }

    if (/^#### (.+)/.test(line)) {
      const content = line.replace(/^#### /, '')
      result.push(`<h4>${renderInlineMarkdown(content)}</h4>`)
      continue
    }

    if (/^### (.+)/.test(line)) {
      const content = line.replace(/^### /, '')
      result.push(`<h3>${renderInlineMarkdown(content)}</h3>`)
      continue
    }

    if (/^## (.+)/.test(line)) {
      const content = line.replace(/^## /, '')
      result.push(`<h2>${renderInlineMarkdown(content)}</h2>`)
      continue
    }

    if (/^# (.+)/.test(line)) {
      const content = line.replace(/^# /, '')
      result.push(`<h1>${renderInlineMarkdown(content)}</h1>`)
      continue
    }

    if (tableMatch) {
      const cells = splitTableCells(tableMatch[1]).map((c) => c.trim())
      const nextLine = lines[i + 1]
      const isHeader = nextLine && /^\|(?:\s*:?-+:?\s*\|)+$/.test(nextLine)

      if (isHeader) {
        flushTable()
        result.push(
          '<table><thead><tr>' +
            cells.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join('') +
            '</tr></thead><tbody>'
        )
        inTable = true
        tableColumnCount = cells.length
        i++
        continue
      }

      if (inTable) {
        // GFM 把 body 行按表头列数对齐: 多余 cell 裁掉, 缺失补空
        const row = Array.from(
          { length: tableColumnCount },
          (_, idx) => cells[idx] ?? ''
        )
        result.push(
          '<tr>' +
            row.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join('') +
            '</tr>'
        )
        continue
      }
    }

    result.push(`<p>${renderInlineMarkdown(line)}</p>`)
  }

  if (inCodeBlock) {
    result.push(`<pre><code>${escapeHtml(codeContent.trimEnd())}</code></pre>`)
  }

  flushTable()
  flushList()

  return result.join('\n') as KunSafeHtml
}
