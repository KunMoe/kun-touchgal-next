// 已净化、可以直接交给 dangerouslySetInnerHTML 的 HTML。
//
// 品牌只存在于编译期, 运行时就是普通字符串。信任根在服务端渲染入口 (各 markdown 管线
// 都以 rehypeSanitize 收尾); 从 Redis 回读的缓存、客户端经 kunFetch 泛型拿到的字段
// 都是隐式信任 —— 品牌拦的是「把没渲染过的字符串接到 HTML 汇点或文本投影上」这类
// 接线错误, 不是运行时校验。能写出 `as KunSafeHtml` 的文件由 lint (inv-content-03) 限定
declare const kunSafeHtmlBrand: unique symbol

export type KunSafeHtml = string & { readonly [kunSafeHtmlBrand]: true }
