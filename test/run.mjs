// 轻量测试入口：用 esbuild 即时打包 TS 测试文件后在 Node 中运行
// 用法：node test/run.mjs [testFile.ts ...]（缺省运行 test/ 下全部 *.test.ts）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function findTests(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) out.push(...findTests(p))
    else if (name.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const entries =
  process.argv.length > 2 ? process.argv.slice(2) : findTests('test')

let failed = 0
for (const [i, entry] of entries.entries()) {
  const outfile = `test/.test-bundle-${i}.mjs`
  console.log(`\n${entry}`)
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      packages: 'external', // jsdom 等 CJS 依赖交由 Node 直接解析
      outfile,
      logLevel: 'silent',
    })
    await import(pathToFileURL(outfile).href)
  } catch (err) {
    console.error(err)
    failed++
  } finally {
    try { rmSync(outfile) } catch { /* ignore */ }
  }
}

if (failed > 0) process.exitCode = 1
