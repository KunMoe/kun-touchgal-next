export const kunCookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV !== 'development',
  maxAge: maxAgeSeconds
})
