// 纯模块, 不 import prisma: 事务执行器与各处重试循环共用这份判据。测试里整模块 mock
// ~/prisma/index 的工厂大多不带它, 执行器若从那里取, 一访问就抛错

const hasRetryablePostgresCode = (value: unknown) => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const code =
    'originalCode' in value
      ? value.originalCode
      : 'code' in value
        ? value.code
        : undefined
  return code === '40001' || code === '40P01'
}

export const isPrismaTransactionConflict = (error: unknown) => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if ('code' in error && error.code === 'P2034') {
    return true
  }
  if ('cause' in error && hasRetryablePostgresCode(error.cause)) {
    return true
  }
  if (!('meta' in error) || typeof error.meta !== 'object' || !error.meta) {
    return false
  }

  const driverError =
    'driverAdapterError' in error.meta
      ? error.meta.driverAdapterError
      : undefined
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    'cause' in driverError &&
    hasRetryablePostgresCode(driverError.cause)
  )
}
