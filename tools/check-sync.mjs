#!/usr/bin/env node
// 共享包同步守卫。
//
// dsh-agent-group 与 dsh-sillytavern 各自存有一份 contracts / group-chat。
// 两份必须逐字节相同——一旦不一致，就有了两个写入者，两边会静默走偏，
// 而且不会报任何错。（旧版就是这样烂掉的：一次改动只覆盖了一半，没人发现。）
//
// 权威副本在 dsh-agent-group：纯群聊仓库，共享包就是它的全部内容。
// 唯一的修法：在 dsh-agent-group 里改，复制到 dsh-sillytavern，然后两个仓库都推。
//
// 用法：pnpm run check:sync
//
// 退出码：
//   0  一致
//   1  不一致（下面会逐个文件列出）
//   2  无法判定（取不到对端仓库，通常是没网）——这个码是「不知道」，不是「通过」

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ORG = 'BOWLUNA'

// 构建产物与依赖不参与比较，它们由各自的 verify 流程重新生成。
const IGNORE = new Set(['node_modules', 'lib', 'dist', '.git', '.tmp', '.turbo'])

const here = resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(join(here, 'tools', 'sync.json'), 'utf8'))
const { repo, sibling, shared } = config

/** 把一个目录里的每个文件映射到它的 sha256，key 是相对该目录的路径。 */
function hashTree(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        out.set(relative(root, abs), createHash('sha256').update(readFileSync(abs)).digest('hex'))
      }
    }
  }
  walk(root)
  return out
}

function fetchSibling() {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
  const url = `https://github.com/${ORG}/${sibling}.git`
  try {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', url, join(stage, 'repo')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    })
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    return { error, url }
  }
  return { dir: join(stage, 'repo'), stage, url }
}

const fetched = fetchSibling()
if (fetched.error) {
  console.error(`无法判定：取不到对端仓库 ${fetched.url}`)
  console.error(`  ${String(fetched.error.stderr ?? fetched.error.message).trim().split('\n')[0]}`)
  console.error('这是「不知道」，不是「通过」。联网后重跑。')
  process.exit(2)
}

let divergent = 0
try {
  const head = execFileSync('git', ['-C', fetched.dir, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  console.log(`${repo}  ←→  ${sibling}@${head}`)
  console.log(`比较：${shared.join('、')}\n`)

  for (const dir of shared) {
    const localRoot = join(here, dir)
    const remoteRoot = join(fetched.dir, dir)

    let local
    let remote
    try {
      local = hashTree(localRoot)
    } catch {
      console.error(`✗ ${dir}：本仓库没有这个目录`)
      divergent += 1
      continue
    }
    try {
      remote = hashTree(remoteRoot)
    } catch {
      console.error(`✗ ${dir}：对端 ${sibling} 没有这个目录`)
      divergent += 1
      continue
    }

    const problems = []
    for (const [file, hash] of local) {
      if (!remote.has(file)) problems.push(`  只在本仓库：${file}`)
      else if (remote.get(file) !== hash) problems.push(`  内容不同：${file}`)
    }
    for (const file of remote.keys()) {
      if (!local.has(file)) problems.push(`  只在 ${sibling}：${file}`)
    }

    if (problems.length === 0) {
      console.log(`✓ ${dir} 一致（${local.size} 个文件）`)
    } else {
      divergent += 1
      console.error(`✗ ${dir} 不一致（本仓库 ${local.size} 个文件 / 对端 ${remote.size} 个）`)
      for (const line of problems.slice(0, 20)) console.error(line)
      if (problems.length > 20) console.error(`  ……还有 ${problems.length - 20} 处`)
    }
  }
} finally {
  rmSync(fetched.stage, { recursive: true, force: true })
}

if (divergent > 0) {
  // 同步目标是「不是权威副本的那一个」，不是写死的 sibling——
  // 从权威仓库自己跑时，sibling 就是待同步的一方。
  const target = [repo, sibling].find((name) => name !== config.canonical) ?? sibling
  console.error(`
共享包已经分叉。两个仓库各有一个写入者，接下来会静默走偏。
修法：在权威仓库 ${ORG}/${config.canonical} 里改，同步到 ${ORG}/${target}，然后两边都推。
`)
  process.exit(1)
}

console.log('\n一致。')
