// 首页轮播的 LazyMotion 异步特性包: 拖拽需要 domMax (含 drag / layout),
// 单独成模块让 Turbopack 切成异步块, 不再随首页入口下发
export { domMax as default } from 'framer-motion'
