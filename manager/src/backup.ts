// 파일 백업·복원 (Git을 쓰지 않으므로 복사본으로 되돌린다)
// - 작업 전: 작업 폴더의 파일을 백업 폴더에 복사하고 스냅샷(해시)을 남긴다
// - 보류 시: 바뀐 파일을 보관 폴더에 저장한 뒤, 백업으로 복원(수정·삭제된 파일 되돌림, 새로 생긴 파일 제거)
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { diffSnapshots, takeSnapshot, type Snapshot, type SnapshotDiff } from "./snapshot"

export interface BackupInfo {
  /** 백업 폴더 */
  dir: string
  /** 백업 시점 스냅샷 */
  snapshot: Snapshot
  copiedFiles: number
  bytes: number
  /** 용량 제한 때문에 일부 파일만 백업했는지 (true면 전체 복원을 보장할 수 없음) */
  partial: boolean
  /** 백업하지 못한 파일 */
  notBackedUp: string[]
}

export interface BackupOptions {
  /** 백업 용량 상한(바이트). 넘으면 priority 파일만 백업한다 */
  maxBytes: number
  /** 반드시 백업할 파일 (계획서의 대상 파일 등, 작업 폴더 기준 상대 경로) */
  priority?: string[]
}

const inside = (root: string, p: string) => {
  const r = resolve(root)
  const t = resolve(p)
  return t === r || t.startsWith(r + sep)
}

function copyInto(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

export function createBackup(root: string, dir: string, o: BackupOptions): BackupInfo {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const snapshot = takeSnapshot(root)
  const paths = Object.keys(snapshot)
  const sizes = new Map<string, number>()
  let total = 0
  for (const p of paths) {
    const size = statSync(join(root, p)).size
    sizes.set(p, size)
    total += size
  }
  const partial = total > o.maxBytes
  const targets = partial ? paths.filter((p) => (o.priority ?? []).includes(p)) : paths
  let bytes = 0
  for (const p of targets) {
    copyInto(join(root, p), join(dir, "files", p))
    bytes += sizes.get(p) ?? 0
  }
  const set = new Set(targets)
  return { dir, snapshot, copiedFiles: targets.length, bytes, partial, notBackedUp: paths.filter((p) => !set.has(p)) }
}

/** 작업 후 바뀐 파일(추가·수정)의 현재 내용을 보관 폴더에 복사한다 (되돌리기 전에 사람이 볼 수 있게) */
export function saveChangedFiles(root: string, diff: SnapshotDiff, destDir: string): string[] {
  const saved: string[] = []
  for (const p of [...diff.added, ...diff.modified]) {
    const src = join(root, p)
    if (!existsSync(src)) continue
    copyInto(src, join(destDir, "files", p))
    saved.push(p)
  }
  return saved
}

export interface RestoreResult {
  /** 원래 내용으로 되돌린 파일 (수정되었거나 삭제된 파일) */
  restored: string[]
  /** 작업 중 새로 생겨서 제거한 파일 */
  deleted: string[]
  /** 백업이 없어 되돌리지 못한 파일 */
  unrestorable: string[]
  failed: string[]
}

/** 백업 시점으로 되돌린다. 작업 폴더 밖은 건드리지 않는다 */
export function restoreFromBackup(root: string, backup: BackupInfo, only?: (path: string) => boolean): RestoreResult {
  const out: RestoreResult = { restored: [], deleted: [], unrestorable: [], failed: [] }
  const diff = diffSnapshots(backup.snapshot, takeSnapshot(root))
  const want = (p: string) => (only ? only(p) : true)

  for (const p of [...diff.modified, ...diff.removed].filter(want)) {
    const src = join(backup.dir, "files", p)
    const dest = join(root, p)
    if (!existsSync(src)) {
      out.unrestorable.push(p)
      continue
    }
    try {
      if (!inside(root, dest)) throw new Error("작업 폴더 밖")
      copyInto(src, dest)
      out.restored.push(p)
    } catch {
      out.failed.push(p)
    }
  }
  for (const p of diff.added.filter(want)) {
    const dest = join(root, p)
    try {
      if (!inside(root, dest)) throw new Error("작업 폴더 밖")
      rmSync(dest, { force: true })
      out.deleted.push(p)
      removeEmptyParents(root, dirname(dest))
    } catch {
      out.failed.push(p)
    }
  }
  return out
}

/** 파일을 지운 뒤 비어 버린 상위 폴더를 작업 폴더 직전까지 정리한다 */
function removeEmptyParents(root: string, dir: string) {
  let cur = resolve(dir)
  const r = resolve(root)
  while (cur !== r && cur.startsWith(r + sep)) {
    try {
      if (readdirSync(cur).length > 0) return
      rmdirSync(cur)
    } catch {
      return
    }
    cur = dirname(cur)
  }
}
