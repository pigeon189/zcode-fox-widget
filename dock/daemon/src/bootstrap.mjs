// 第一段执行：把 --data-dir 解析成完整数据目录并写入 FOX_DOCK_DATA，
// 供后续静态导入的 engines/paths.mjs 在求值 DATA_DIR 时使用。
// 必须作为 daemon.mjs 的第一个 import：ESM 按源码顺序求值依赖，晚于
// v1/adapters 再设置就来不及了（它们会静态导入 engines/paths.mjs）。
import path from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || ''
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : ''
}

const dataDir = String(arg('--data-dir') || process.env.FOX_DOCK_DATA || '').trim()
if (dataDir) process.env.FOX_DOCK_DATA = path.resolve(dataDir)
