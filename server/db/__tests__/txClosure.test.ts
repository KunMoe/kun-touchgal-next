import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// kunTx 的回调会被整段重放 (retry), 也可能在写了一半之后回滚。回调的输出只能走返回值与
// ctx: 给外层变量赋值、往外层数组里 push 的话, 被丢弃的那一轮留下的值会混进最终结果
// (重放时累加、换了分支后残留上一轮的真值)。这里按语法树逐个检查全部 kunTx 调用

const REPO_ROOT = join(import.meta.dirname, '../../..')
const SCANNED_DIRS = ['app', 'server', 'lib']

// 原地改写接收者的方法; 只认直接挂在外层标识符上的调用 (outer.push(x))
const MUTATORS = new Set([
  'push',
  'unshift',
  'splice',
  'pop',
  'shift',
  'sort',
  'reverse',
  'fill',
  'set',
  'add',
  'clear'
])

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression

const isFunctionNode = (node: ts.Node | undefined): node is FunctionNode =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))

const bindingNames = (name: ts.BindingName, into: Set<string>) => {
  if (ts.isIdentifier(name)) {
    into.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      bindingNames(element.name, into)
    }
  }
}

// a.b[c]!.d 的根标识符 a
const rootIdentifier = (node: ts.Expression): string | null => {
  let current = node
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : null
}

// 回调自己声明的名字 (参数、局部变量、内层函数、catch 变量); 其余标识符都算外层的
const declaredInside = (callback: FunctionNode) => {
  const names = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      bindingNames(node.name, names)
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(callback)
  return names
}

const outerWritesIn = (callback: FunctionNode) => {
  const declared = declaredInside(callback)
  const isOuter = (name: string | null): name is string =>
    name !== null && !declared.has(name)
  const found: Array<{ node: ts.Node; what: string }> = []

  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const root = rootIdentifier(node.left)
      if (isOuter(root)) {
        found.push({ node, what: `给外层的 ${root} 赋值` })
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const root = rootIdentifier(node.operand)
      if (isOuter(root)) {
        found.push({ node, what: `自增或自减外层的 ${root}` })
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATORS.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      isOuter(node.expression.expression.text)
    ) {
      found.push({
        node,
        what: `调用外层的 ${node.expression.expression.text}.${node.expression.name.text}`
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(callback.body)
  return found
}

// 返回形如「文件:行 说明」的问题清单。回调既可以内联写在 kunTx 的第二个参数里, 也可以是
// 同文件里单独声明的函数 (资源创建 / 编辑为了不让整段事务体重缩进而这样写)
const scanSource = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const localFunctions = new Map<string, FunctionNode>()
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isFunctionNode(node.initializer)
    ) {
      localFunctions.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  const problems: string[] = []
  let calls = 0
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'kunTx'
    ) {
      calls++
      const body = node.arguments[1]
      const callback = isFunctionNode(body)
        ? body
        : body && ts.isIdentifier(body)
          ? localFunctions.get(body.text)
          : undefined
      if (!callback) {
        problems.push(`${file}:${lineOf(node)} 找不到 kunTx 的回调, 无从检查`)
      } else {
        for (const { node: write, what } of outerWritesIn(callback)) {
          problems.push(`${file}:${lineOf(write)} ${what}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { calls, problems }
}

const sourceFiles = () =>
  SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: 'utf-8' })
      .map((entry) => join(dir, entry))
      .filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !file.includes('__tests__') &&
          !file.includes('node_modules')
      )
  )

describe('kunTx 回调不向外层写', () => {
  it('检查器认得出三种外层写入, 也认得单独声明的回调', () => {
    const { problems } = scanSource(
      'sample.ts',
      `
      export const run = async () => {
        let total = 0
        const state = { done: false }
        const ids: number[] = []
        await kunTx('a', async ({ tx }) => {
          total = await tx.user.count()
          state.done = true
          ids.push(1)
          total++
        })
        const body = async ({ tx }: KunTxContext) => {
          ids.unshift(await tx.user.count())
        }
        await kunTx('b', body)
        await kunTx('c', makeBody())
      }
      `
    )

    expect(problems).toEqual([
      'sample.ts:7 给外层的 total 赋值',
      'sample.ts:8 给外层的 state 赋值',
      'sample.ts:9 调用外层的 ids.push',
      'sample.ts:10 自增或自减外层的 total',
      'sample.ts:13 调用外层的 ids.unshift',
      'sample.ts:16 找不到 kunTx 的回调, 无从检查'
    ])
  })

  it('回调自己的变量、返回值与 ctx 上的登记不算', () => {
    const { calls, problems } = scanSource(
      'sample.ts',
      `
      export const run = (input: { ids: number[] }) =>
        kunTx('a', async ({ tx, afterCommit }) => {
          const removed: number[] = []
          let count = 0
          for (const id of input.ids) {
            count += (await tx.user.deleteMany({ where: { id } })).count
            removed.push(id)
          }
          const seen = new Set<number>()
          seen.add(count)
          afterCommit('cache', () => invalidate(removed))
          return { count, removed }
        })
      `
    )

    expect(calls).toBe(1)
    expect(problems).toEqual([])
  })

  it('app / server / lib 下的全部 kunTx 回调', () => {
    let calls = 0
    const problems: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8')
      if (!text.includes('kunTx(')) {
        continue
      }
      const scanned = scanSource(file, text)
      calls += scanned.calls
      problems.push(...scanned.problems)
    }

    // 一个都没扫到说明检查器失效了 (目录改名、调用写法变了), 不是没有问题
    expect(calls).toBeGreaterThan(50)
    expect(problems).toEqual([])
  })
})
