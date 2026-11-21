// 人机验证按钮上的字: 换字时哪几行在场, 各自处在滑入 / 就位 / 滑出的哪一步。
// 画法在 CaptchaModal.tsx 的 KunCapLabel, 这里只管这份名单怎么变

export interface KunCapLine {
  id: number
  text: string
  phase: 'enter' | 'active' | 'exit'
}

export const initialKunCapLines = (text: string): KunCapLine[] => [
  { id: 0, text, phase: 'active' }
]

// 把显示的字换成 text: 在场的行全部转为滑出, 末尾加一行等着滑入。
// still 为真时不做动画, 直接只剩新的一行 (连还在滑出的旧行也一并拿掉)
export const changeKunCapLines = (
  lines: KunCapLine[],
  text: string,
  still: boolean
): KunCapLine[] => {
  const shown = lines.filter((line) => line.phase !== 'exit').pop()
  if (shown?.text === text) {
    return lines
  }
  const id = lines[lines.length - 1].id + 1
  return still
    ? [{ id, text, phase: 'active' }]
    : [
        ...lines.map((line) => ({ ...line, phase: 'exit' as const })),
        { id, text, phase: 'enter' }
      ]
}

// 等着滑入的行已经按起点落到页面上了, 放它到位
export const settleKunCapLines = (lines: KunCapLine[]): KunCapLine[] =>
  lines.some((line) => line.phase === 'enter')
    ? lines.map((line) =>
        line.phase === 'enter' ? { ...line, phase: 'active' } : line
      )
    : lines

// 一行滑出完毕, 拿掉它; 没在滑出的行不受影响
export const removeKunCapLine = (
  lines: KunCapLine[],
  id: number
): KunCapLine[] =>
  lines.filter((line) => line.id !== id || line.phase !== 'exit')
