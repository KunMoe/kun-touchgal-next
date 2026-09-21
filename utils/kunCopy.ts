import toast from 'react-hot-toast'

export const kunCopy = (text: string) => {
  navigator.clipboard
    .writeText(text)
    .then(() =>
      toast.success(`${text} 复制成功`, {
        style: {
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }
      })
    )
    .catch(() => toast.error('复制失败! 请更换更现代的浏览器!'))
}
