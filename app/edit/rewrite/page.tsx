import { redirect } from 'next/navigation'

// 重写页搬到了 /edit/rewrite/[uniqueId], 由页面自己读取要编辑的游戏。
// 不带 id 的旧地址无从得知要编辑哪一个
export default function Kun() {
  redirect('/')
}
