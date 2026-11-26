import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { getKunMarkdownProcessor } from '~/app/api/utils/render/processor'

const renderCommentHtml = async (markdown: string) =>
  String(await getKunMarkdownProcessor('comment').process(markdown))

// 证伪基准：含机器相关的耗时断言，默认不随 CI 运行。
// 需要复现“同步阻塞 + 超时空转”时用 RUN_BENCH=1 pnpm test 触发。
const bench = describe.runIf(process.env.RUN_BENCH === '1')

// 证伪基准：验证 markdown 渲染是否在事件循环上同步阻塞，且 Promise.race 式的渲染
// 超时对其是否空转（结论是空转，渲染入口因此不再套这层超时）。
// 不改生产代码，仅通过裸 unified processor（无缓存）取硬数据。
//
// 关键测量方法：探针法。在调用 render 前调度一个 setTimeout(0) 探针，并强制
// await 到它真正触发，测其被推迟的时长 probeDelay。
//   - 若 render 同步阻塞事件循环，探针无法在渲染完成前触发 → probeDelay ≈ renderMs
//   - 若 render 真异步让出，探针在渲染早期即触发 → probeDelay ≈ 0
// 用“忙等”和“真异步等待”两个金标准对照，先验证探针法本身可信，再据此判定 render。

const buildPathologicalMarkdown = () => {
  const parts: string[] = []

  for (let i = 0; i < 800; i++) {
    parts.push(
      `> > **粗体段落 ${i}** *斜体强调* \`inlineCode${i}\` [外链文本](https://example.com/path/${i}) 一段用于填充字节的中文正文内容，包含标点，、。！？以及数字 ${i} 与英文 mixed content。`
    )
  }

  for (let t = 0; t < 3; t++) {
    parts.push('| 列 A | 列 B | 列 C | 列 D |')
    parts.push('| --- | --- | --- | --- |')
    for (let r = 0; r < 300; r++) {
      parts.push(
        `| 单元格 ${r} A 内容 | 单元格 ${r} B 内容 | 单元格 ${r} C 内容 | 单元格 ${r} D 内容 |`
      )
    }
  }

  for (let c = 0; c < 2; c++) {
    parts.push('```javascript')
    for (let l = 0; l < 500; l++) {
      parts.push(
        `const value${l} = { id: ${l}, name: 'item-${l}', tags: [${l}, ${l + 1}, ${l + 2}], active: ${l % 2 === 0} }`
      )
    }
    parts.push('```')
  }

  return parts.join('\n\n')
}

// 探针法：调度 setTimeout(0)，同步启动 renderCall，await 渲染完成后再 await 探针，
// 返回渲染耗时与探针被推迟时长。probeDelay ≈ renderMs 即证明同步阻塞。
const measureProbeDelay = async (operationFactory: () => Promise<unknown>) => {
  const scheduledAt = performance.now()
  let probeDelay = -1
  const probe = new Promise<void>((resolve) => {
    setTimeout(() => {
      probeDelay = performance.now() - scheduledAt
      resolve()
    }, 0)
  })

  const start = performance.now()
  const operation = operationFactory()
  await operation
  const elapsed = performance.now() - start

  await probe
  return { elapsed, probeDelay }
}

const busyWait = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // 纯忙等，已知会同步阻塞事件循环 —— 金标准
  }
}

const raceWithTimeout = <T>(operation: Promise<T>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('render-timeout')), timeoutMs)
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

const SHORT_TIMEOUT_MS = 25
const GOLDEN_BLOCK_MS = 300

const pathologicalMarkdown = buildPathologicalMarkdown()
const markdownBytes = Buffer.byteLength(pathologicalMarkdown, 'utf8')

bench('探针法自校验（金标准对照）', () => {
  it('金标准·同步忙等：探针被推迟 ≈ 阻塞时长', async () => {
    const { probeDelay } = await measureProbeDelay(async () => {
      busyWait(GOLDEN_BLOCK_MS)
    })

    console.log(
      `[金标准·同步忙等 ${GOLDEN_BLOCK_MS}ms] probeDelay=${probeDelay.toFixed(1)}ms`
    )

    // 同步阻塞 → 探针无法在阻塞期间触发
    expect(probeDelay).toBeGreaterThan(GOLDEN_BLOCK_MS * 0.6)
  }, 30000)

  it('金标准·真异步等待：探针几乎不被推迟', async () => {
    const { probeDelay } = await measureProbeDelay(
      () => new Promise((resolve) => setTimeout(resolve, GOLDEN_BLOCK_MS))
    )

    console.log(
      `[金标准·真异步 ${GOLDEN_BLOCK_MS}ms] probeDelay=${probeDelay.toFixed(1)}ms`
    )

    // 真异步让出 → setTimeout(0) 探针在早期即触发
    expect(probeDelay).toBeLessThan(GOLDEN_BLOCK_MS * 0.5)
  }, 30000)
})

bench('待测：markdown 渲染是否同步阻塞事件循环', () => {
  it('渲染 patch 级病态文档并测探针延迟', async () => {
    const { elapsed, probeDelay } = await measureProbeDelay(() =>
      renderCommentHtml(pathologicalMarkdown)
    )

    const blockingRatio = probeDelay / elapsed
    console.log(
      `[待测·渲染] 文档 ${(markdownBytes / 1024).toFixed(1)}KB | renderMs=${elapsed.toFixed(1)} | probeDelay=${probeDelay.toFixed(1)} | blockingRatio=${blockingRatio.toFixed(2)} → ${blockingRatio > 0.6 ? '同步阻塞' : '未阻塞/让出'}`
    )

    // 渲染确实耗时可观（证明成本存在）
    expect(elapsed).toBeGreaterThan(SHORT_TIMEOUT_MS * 2)
    // 判定：若同步阻塞，probeDelay 应逼近 renderMs
    expect(probeDelay).toBeGreaterThan(elapsed * 0.6)
  }, 30000)
})

bench('Promise.race 超时对同步 vs 真异步的行为对照', () => {
  it('实验组：短超时对 markdown 渲染空转（render 赢）', async () => {
    let outcome: 'rendered' | 'timeout'
    const start = performance.now()
    try {
      await raceWithTimeout(
        renderCommentHtml(pathologicalMarkdown),
        SHORT_TIMEOUT_MS
      )
      outcome = 'rendered'
    } catch {
      outcome = 'timeout'
    }
    const elapsed = performance.now() - start

    console.log(
      `[实验组·超时空转] timeout=${SHORT_TIMEOUT_MS}ms | elapsed=${elapsed.toFixed(1)}ms | outcome=${outcome}`
    )

    expect(outcome).toBe('rendered')
    expect(elapsed).toBeGreaterThan(SHORT_TIMEOUT_MS)
  }, 30000)

  it('对照组：短超时对真异步 render 生效（timeout 赢）', async () => {
    const slowAsyncRender = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('done'), 300))

    let outcome: 'rendered' | 'timeout'
    try {
      await raceWithTimeout(slowAsyncRender(), SHORT_TIMEOUT_MS)
      outcome = 'rendered'
    } catch {
      outcome = 'timeout'
    }

    console.log(
      `[对照组·超时有效] timeout=${SHORT_TIMEOUT_MS}ms vs asyncRender=300ms | outcome=${outcome}`
    )

    expect(outcome).toBe('timeout')
  }, 30000)
})
