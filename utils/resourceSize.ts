// 对象存储文件的大小写成资源链接上展示的样子。上传界面的预览、上传完成的应答与落库的
// 大小都出自这一个函数, 三处看到的是同一个数
export const formatResourceSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(3)} MB`
