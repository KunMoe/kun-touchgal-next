import { defaultHandlers } from 'remark-rehype'
import type { Options } from 'remark-rehype'

type Handler = NonNullable<NonNullable<Options['handlers']>['listItem']>

interface ListLike {
  type: string
  spread?: boolean | null
  children: { spread?: boolean | null; children: unknown[] }[]
}

// 上游把一个列表项转成 HTML 之前, 要先问它所在的列表是松是紧, 而每问一次都把全部
// 兄弟项扫一遍。紧凑列表没有哪一项能让它提前停下: 五万个列表项就是二十五亿次比较,
// 10 万字符的简介光这一步就要 5 秒。
//
// 这里按列表把结论记下来, 每个列表只算一次, 再交给上游的处理器。判断规则与上游的
// listLoose / listItemLoose 相同, 输出不变
const looseness = new WeakMap<object, boolean>()

const isLoose = (list: ListLike) => {
  let loose = looseness.get(list)
  if (loose === undefined) {
    loose =
      list.type === 'list' &&
      (list.spread ||
        list.children.some((item) =>
          item.spread === null || item.spread === undefined
            ? item.children.length > 1
            : item.spread
        ))
    looseness.set(list, loose)
  }
  return loose
}

export const kunListItemHandler: Handler = (state, node, parent) =>
  defaultHandlers.listItem(
    state,
    node,
    // 上游只拿 parent 来问松紧: 给它一个结论已定、不必再扫的替身
    parent && {
      type: 'list',
      spread: isLoose(parent as ListLike),
      children: []
    }
  )
