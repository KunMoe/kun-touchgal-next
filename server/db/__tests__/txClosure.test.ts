import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// kunTx 的回调会被整段重放 (retry), 也可能在写了一半之后回滚。回调的输出只能走返回值与
// ctx: 给外层变量赋值、往外层数组里 push 的话, 被丢弃的那一轮留下的值会混进最终结果
// (重放时累加、换了分支后残留上一轮的真值)。这里按语法树逐个检查全部 kunTx 调用。
//
// 查得到的: 回调体内 (含登记给 afterCommit / onRollback 的函数) 直接写外层变量的语句。
// 查不到的: 回调调用的别的函数内部做的写入; 经回调自己的变量间接改到的外层对象

const REPO_ROOT = join(import.meta.dirname, '../../..')
const SCANNED_DIRS = ['app', 'server', 'lib']

// 原地改写接收者的方法
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

// (a.b[c]!.d as T) 的根标识符 a; 根不是标识符 (调用结果、字面量) 时为 null
const rootIdentifier = (node: ts.Expression): ts.Identifier | null => {
  let current = node
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current : null
}

// 赋值号左边可能是解构: ({ a, b: c.d } = …)、[a, ...rest] = …
const assignmentRoots = (target: ts.Node): ts.Identifier[] => {
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? [property.name]
        : ts.isPropertyAssignment(property)
          ? assignmentRoots(property.initializer)
          : ts.isSpreadAssignment(property)
            ? assignmentRoots(property.expression)
            : []
    )
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      assignmentRoots(
        ts.isSpreadElement(element) ? element.expression : element
      )
    )
  }
  if (ts.isBinaryExpression(target)) {
    // 解构里带默认值: [a = 1] = …
    return assignmentRoots(target.left)
  }
  const root = ts.isExpression(target) ? rootIdentifier(target) : null
  return root ? [root] : []
}

// 单文件建一个不解析导入、不带标准库的程序: 只用它的绑定结果回答「这个标识符是在哪儿声明的」
const analyze = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === file,
    readFile: (name) => (name === file ? text : undefined)
  }
  const checker = ts
    .createProgram(
      [file],
      { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
      host
    )
    .getTypeChecker()
  return { source, checker }
}

// 返回形如「文件:行 说明」的问题清单。回调既可以内联写在 kunTx 的第二个参数里, 也可以是
// 同文件里单独声明的函数 (资源创建 / 编辑为了不让整段事务体重缩进而这样写)
const scanSource = (file: string, text: string) => {
  const { source, checker } = analyze(file, text)
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const symbolOf = (identifier: ts.Identifier) =>
    ts.isShorthandPropertyAssignment(identifier.parent)
      ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : checker.getSymbolAtLocation(identifier)

  // 声明全部落在回调之内才算回调自己的; 解析不到声明的 (全局对象) 也算外层
  const isOuter = (identifier: ts.Identifier, callback: FunctionNode) => {
    const declarations = symbolOf(identifier)?.declarations ?? []
    return !(
      declarations.length > 0 &&
      declarations.every(
        (declaration) =>
          declaration.pos >= callback.pos && declaration.end <= callback.end
      )
    )
  }

  const outerWritesIn = (callback: FunctionNode) => {
    const found: Array<{ node: ts.Node; what: string }> = []
    const report = (
      node: ts.Node,
      root: ts.Identifier | null,
      verb: string
    ) => {
      if (root && isOuter(root, callback)) {
        found.push({ node, what: `${verb}外层的 ${root.text}` })
      }
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        for (const root of assignmentRoots(node.left)) {
          report(node, root, '赋值给')
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        report(node, rootIdentifier(node.operand), '自增或自减')
      }
      if (ts.isDeleteExpression(node)) {
        report(node, rootIdentifier(node.expression), '删除属性于')
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const { expression: receiver, name } = node.expression
        if (MUTATORS.has(name.text)) {
          report(node, rootIdentifier(receiver), `调用 ${name.text} 改写`)
        }
        if (
          ts.isIdentifier(receiver) &&
          receiver.text === 'Object' &&
          name.text === 'assign' &&
          node.arguments[0]
        ) {
          report(node, rootIdentifier(node.arguments[0]), 'Object.assign 改写')
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(callback.body)
    return found
  }

  const registersRollback = (callback: FunctionNode) => {
    let found = false
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        found ||= name === 'onRollback'
      }
      ts.forEachChild(node, visit)
    }
    visit(callback.body)
    return found
  }

  // import { kunTx as begin } 之后的本地名
  const localNames = new Set<string>()
  for (const statement of source.statements) {
    const bindings =
      ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'kunTx') {
          localNames.add(element.name.text)
        }
      }
    }
  }
  const isKunTxCall = (node: ts.CallExpression) =>
    ts.isIdentifier(node.expression)
      ? localNames.has(node.expression.text)
      : ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'kunTx'

  const resolveCallback = (argument: ts.Expression | undefined) => {
    if (isFunctionNode(argument)) {
      return argument
    }
    if (argument && ts.isIdentifier(argument)) {
      const declaration =
        checker.getSymbolAtLocation(argument)?.declarations?.[0]
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        isFunctionNode(declaration.initializer)
      ) {
        return declaration.initializer
      }
    }
    return undefined
  }

  const problems: string[] = []
  let calls = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isKunTxCall(node)) {
      calls++
      const callback = resolveCallback(node.arguments[1])
      if (!callback) {
        problems.push(`${file}:${lineOf(node)} 找不到 kunTx 的回调, 无从检查`)
      } else {
        for (const { node: write, what } of outerWritesIn(callback)) {
          problems.push(`${file}:${lineOf(write)} ${what}`)
        }
        // 回调里才产生的库外产物靠 ctx.onRollback 清理, 而它只在最终没有提交时执行:
        // 开了 retry 的话, 被重放掉的那一轮的产物在最终提交后没有人清理
        const options = node.arguments[2]
        if (options && registersRollback(callback)) {
          if (!ts.isObjectLiteralExpression(options)) {
            problems.push(
              `${file}:${lineOf(node)} 回调登记了 onRollback, 选项不是字面量, 看不出有没有开 retry`
            )
          } else if (
            options.properties.some(
              (property) =>
                !ts.isPropertyAssignment(property) ||
                !ts.isIdentifier(property.name) ||
                property.name.text === 'retry'
            )
          ) {
            problems.push(
              `${file}:${lineOf(node)} 回调登记了 onRollback 的事务不能开 retry (选项须逐项写明)`
            )
          }
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
  it('认得出各种写外层变量的写法', () => {
    const { problems } = scanSource(
      'sample.ts',
      `import { kunTx } from '~/server/db/tx'
export const run = async () => {
  let total = 0
  let first = 0
  const state = { done: false, ids: [] as number[] }
  const ids: number[] = []
  await kunTx('a', async ({ tx }) => {
    total = await tx.user.count()
    state.done = true
    ids.push(1)
    total++
    state.ids.push(2)
    Object.assign(state, { done: false })
    delete (state as { done?: boolean }).done
    ;[first] = ids
    ;({ total } = { total: 1 })
  })
}
`
    )

    expect(problems).toEqual([
      'sample.ts:8 赋值给外层的 total',
      'sample.ts:9 赋值给外层的 state',
      'sample.ts:10 调用 push 改写外层的 ids',
      'sample.ts:11 自增或自减外层的 total',
      'sample.ts:12 调用 push 改写外层的 state',
      'sample.ts:13 Object.assign 改写外层的 state',
      'sample.ts:14 删除属性于外层的 state',
      'sample.ts:15 赋值给外层的 first',
      'sample.ts:16 赋值给外层的 total'
    ])
  })

  it('按作用域认: 回调里别处有个同名的局部变量, 不能让外层那个蒙混过去', () => {
    const { problems } = scanSource(
      'sample.ts',
      `import { kunTx } from '~/server/db/tx'
export const run = async (rows: number[]) => {
  let total = 0
  await kunTx('a', async () => {
    rows.forEach((total) => console.log(total))
    total = rows.length
  })
}
`
    )

    expect(problems).toEqual(['sample.ts:6 赋值给外层的 total'])
  })

  it('认得改了名的导入、带类型参数的调用与单独声明的回调', () => {
    const { calls, problems } = scanSource(
      'sample.ts',
      `import { kunTx as begin } from '~/server/db/tx'
import * as db from '~/server/db/tx'
export const run = async () => {
  const ids: number[] = []
  await begin<void>('a', async () => {
    ids.push(1)
  })
  const body = async ({ tx }: KunTxContext) => {
    ids.unshift(await tx.user.count())
  }
  await db.kunTx('b', body)
  await begin('c', makeBody())
}
`
    )

    expect(calls).toBe(3)
    expect(problems).toEqual([
      'sample.ts:6 调用 push 改写外层的 ids',
      'sample.ts:9 调用 unshift 改写外层的 ids',
      'sample.ts:12 找不到 kunTx 的回调, 无从检查'
    ])
  })

  it('回调自己的变量、返回值与 ctx 上的登记不算', () => {
    const { calls, problems } = scanSource(
      'sample.ts',
      `import { kunTx } from '~/server/db/tx'
export const run = (input: { ids: number[] }) =>
  kunTx('a', async ({ tx, afterCommit }) => {
    const removed: number[] = []
    const state = { count: 0 }
    let count = 0
    for (const id of input.ids) {
      count += (await tx.user.deleteMany({ where: { id } })).count
      removed.push(id)
    }
    state.count = count
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

  it('回调登记了 onRollback 的事务不能开 retry', () => {
    const { problems } = scanSource(
      'sample.ts',
      `import { kunTx } from '~/server/db/tx'
export const run = async () => {
  await kunTx('a', async ({ onRollback }) => { onRollback('banner', cleanup) }, { timeout: 60000 })
  await kunTx('b', async (ctx) => { ctx.onRollback('banner', cleanup) }, { retry: 2 })
  await kunTx('c', async ({ onRollback }) => { onRollback('banner', cleanup) }, options)
  await kunTx('d', async ({ onRollback }) => { onRollback('banner', cleanup) }, { ...options })
  await kunTx('e', async () => {}, { retry: 2, onRollback: cleanup })
}
`
    )

    expect(problems).toEqual([
      'sample.ts:4 回调登记了 onRollback 的事务不能开 retry (选项须逐项写明)',
      'sample.ts:5 回调登记了 onRollback, 选项不是字面量, 看不出有没有开 retry',
      'sample.ts:6 回调登记了 onRollback 的事务不能开 retry (选项须逐项写明)'
    ])
  })

  it('app / server / lib 下的全部 kunTx 回调', () => {
    let calls = 0
    const problems: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8')
      if (!text.includes('kunTx')) {
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
