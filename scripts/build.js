import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const sourceFile = join(root, 'src', 'index.js')
const outputFile = join(distDir, 'index.js')

// hls.js 运行时不入仓库，编译时从 CDN 拉取并缓存到 node_modules（已被 .gitignore）
const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.11/dist/hls.min.js'
const hlsCacheFile = join(root, 'node_modules', '.cache', 'tingfm', 'hls.min.js')

async function loadHls() {
  if (existsSync(hlsCacheFile)) {
    console.log('[tingfm-radio] 使用本地 hls.js 缓存')
    return readFileSync(hlsCacheFile, 'utf8')
  }
  const res = await fetch(HLS_URL)
  if (!res.ok) throw new Error(`hls.js 拉取失败: HTTP ${res.status}`)
  const text = await res.text()
  mkdirSync(dirname(hlsCacheFile), { recursive: true })
  writeFileSync(hlsCacheFile, text, 'utf8')
  console.log('[tingfm-radio] hls.js 已下载并缓存')
  return text
}

// 插件以 Blob 整体加载，必须为单文件 ESM：将 hls.js 与插件源码拼接合并
const hls = await loadHls()
const source = readFileSync(sourceFile, 'utf8')

// 对合并结果做最小化压缩：去除注释与空白，压缩变量名，尽量简并行
const raw = `${hls}\n\n${source}\n`
const { code } = await transform(raw, {
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
})

mkdirSync(distDir, { recursive: true })
writeFileSync(outputFile, code, 'utf8')
const kb = (Buffer.byteLength(code) / 1024).toFixed(1)
console.log(`[tingfm-radio] 已生成 dist/index.js (${kb} KB, minified)`)