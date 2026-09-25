// 深链 ?commentId= / ?ratingId= / ?resourceId= 的取值: 只接受正的安全整数
export const parseDeepLinkId = (raw: string | null) => {
  if (!raw) {
    return null
  }

  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
