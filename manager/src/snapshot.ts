// 작업 폴더 스냅샷: 파일 해시 목록을 떠 두고 두 시점의 차이(추가/수정/삭제)를 구한다
// 낮 모드의 "이미 수정된 파일" 요약과 밤 모드의 백업·복원 판단에 쓴다 (Git을 쓰지 않는다)
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const IGNORED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "__pycache__", ".venv", "venv", ".idea", ".gradle", ".batch", ".plan", ".notes", ".opencode"])
const HASH_LIMIT_BYTES = 2_000_000

export type Snapshot = Record<string, string>

export interface SnapshotOptions {
  ignoreDirs?: Iterable<string>
  maxFiles?: number
}

export function takeSnapshot(root: string, opts: SnapshotOptions = {}): Snapshot {
  const ignore = new Set([...IGNORED_DIRS, ...(opts.ignoreDirs ?? [])])
  const max = opts.maxFiles ?? 50_000
  const out: Snapshot = {}
  let count = 0
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (count >= max) return
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!ignore.has(name)) walk(full)
      } else if (st.isFile()) {
        const rel = relative(root, full).split(sep).join("/")
        // 큰 파일은 내용 대신 크기와 수정 시각으로 변경을 판단한다
        out[rel] = st.size > HASH_LIMIT_BYTES ? `big:${st.size}:${st.mtimeMs}` : createHash("sha1").update(readFileSync(full)).digest("hex")
        count++
      }
    }
  }
  walk(root)
  return out
}

export interface SnapshotDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  for (const [p, h] of Object.entries(after)) {
    if (!(p in before)) added.push(p)
    else if (before[p] !== h) modified.push(p)
  }
  for (const p of Object.keys(before)) if (!(p in after)) removed.push(p)
  return { added, modified, removed }
}

export const changedPaths = (d: SnapshotDiff): string[] => [...d.added, ...d.modified, ...d.removed].sort()
