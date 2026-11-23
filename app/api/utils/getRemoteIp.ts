// 无条件优先信 CF-Connecting-IP, 前提是源站只接受 Cloudflare 回源; 退到 X-Forwarded-For 首段
// 与 X-Real-IP 时, 取决于 nginx 是覆盖写还是追加。这两条都是边缘的义务, 应用验证不了, 见
// decision-making/7.edge-security-contract.md 第二部分的 ① 与 ②
export const getRemoteIp = (headers: Headers): string => {
  const ipForwarded = () => {
    const ip = headers.get('x-forwarded-for')
    if (Array.isArray(ip)) {
      return ip[0]
    } else {
      return ip?.split(',')[0]?.trim() ?? ''
    }
  }

  const xRealIp = headers.get('x-real-ip')
  const cfConnectingIp = headers.get('CF-Connecting-IP')

  return cfConnectingIp || ipForwarded() || xRealIp || ''
}
