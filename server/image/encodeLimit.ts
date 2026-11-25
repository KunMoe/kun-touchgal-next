// 编码并发护栏: 限制单进程内同时进行的 sharp/libvips 编码单元数,
// 避免打满 libuv 线程池 (默认 UV_THREADPOOL_SIZE) 后拖慢同池的 fs / dns.lookup.
// 与 instrumentation.ts 里的 sharp.concurrency(1) 配合, 使并发计数与线程占用一致.
const MAX_CONCURRENT_ENCODE = 2

// 等待队列硬上限与排队超时: 在"同时编码数"之外再给"已承诺处理的总工作量"封顶.
// 无此上限时突发上传会把请求无界堆入 waiters, 每个等待者钉住一份 ≤10MB 上传 buffer
// 直至 OOM; 超时用于回收长期排不到槽、buffer 却一直驻留的僵尸等待者.
export const MAX_QUEUE_DEPTH = 32
export const QUEUE_TIMEOUT_MS = 10_000

// 队列已满或排队超时的信号: 上传管线 (pipeline.ts 的 encodeVariants) 据此返回限流提示,
// 不让异常冒泡成 500. 这个模块只在 server/image 内部使用, 是唯一持有编码状态的地方
export class EncodeBusyError extends Error {
  constructor(message = '服务器繁忙, 请稍后重试') {
    super(message)
    this.name = 'EncodeBusyError'
  }
}

interface Waiter {
  resolve: () => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

let active = 0
const waiters: Waiter[] = []

const acquire = (): Promise<void> => {
  if (active < MAX_CONCURRENT_ENCODE) {
    active++
    return Promise.resolve()
  }
  if (waiters.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new EncodeBusyError())
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: () => {
        clearTimeout(waiter.timer)
        resolve()
      },
      reject,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index !== -1) {
          waiters.splice(index, 1)
        }
        reject(new EncodeBusyError('图片编码排队超时, 请稍后重试'))
      }, QUEUE_TIMEOUT_MS)
    }
    waiters.push(waiter)
  })
}

const release = () => {
  const next = waiters.shift()
  if (next) {
    next.resolve()
  } else {
    active--
  }
}

export const withEncodeSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  await acquire()
  try {
    return await task()
  } finally {
    release()
  }
}
