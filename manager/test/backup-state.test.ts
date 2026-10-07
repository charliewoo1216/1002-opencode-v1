import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBackup, restoreFromBackup, saveChangedFiles } from "../src/backup"
import { addEvent, loadNightState, newTaskState, nightStatePath, prepareResume, saveNightState, type NightState } from "../src/nightstate"
import { layoutFor } from "../src/paths"
import { diffSnapshots, takeSnapshot } from "../src/snapshot"

function work() {
  const root = mkdtempSync(join(tmpdir(), "ocx-bk-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src/a.py"), "a-original")
  writeFileSync(join(root, "src/b.py"), "b-original")
  writeFileSync(join(root, "keep.txt"), "keep")
  return root
}

describe("백업과 복원", () => {
  test("수정·삭제·추가를 모두 원래대로 되돌린다", () => {
    const root = work()
    const dir = join(root, ".batch/backup/current")
    const b = createBackup(root, dir, { maxBytes: 1_000_000 })
    expect(b.partial).toBe(false)
    expect(b.copiedFiles).toBe(3)

    writeFileSync(join(root, "src/a.py"), "a-CHANGED")
    writeFileSync(join(root, "src/b.py"), "") // 내용을 비움
    mkdirSync(join(root, "gen/deep"), { recursive: true })
    writeFileSync(join(root, "gen/deep/new.py"), "new")
    writeFileSync(join(root, "src/c.py"), "c")
    const { rmSync } = require("node:fs")
    rmSync(join(root, "keep.txt"))

    const r = restoreFromBackup(root, b)
    expect(readFileSync(join(root, "src/a.py"), "utf8")).toBe("a-original")
    expect(readFileSync(join(root, "src/b.py"), "utf8")).toBe("b-original")
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(root, "src/c.py"))).toBe(false)
    expect(existsSync(join(root, "gen"))).toBe(false) // 비어 버린 폴더도 정리
    expect(r.restored.sort()).toEqual(["keep.txt", "src/a.py", "src/b.py"])
    expect(r.deleted.sort()).toEqual(["gen/deep/new.py", "src/c.py"])
    expect(diffSnapshots(b.snapshot, takeSnapshot(root))).toEqual({ added: [], modified: [], removed: [] })
  })

  test("복원 전에 바뀐 파일을 보관 폴더에 저장할 수 있다", () => {
    const root = work()
    const b = createBackup(root, join(root, ".batch/backup/current"), { maxBytes: 1_000_000 })
    writeFileSync(join(root, "src/a.py"), "a-CHANGED")
    writeFileSync(join(root, "src/new.py"), "new")
    const diff = diffSnapshots(b.snapshot, takeSnapshot(root))
    const held = join(root, ".batch/held/T1")
    expect(saveChangedFiles(root, diff, held).sort()).toEqual(["src/a.py", "src/new.py"])
    restoreFromBackup(root, b)
    expect(readFileSync(join(held, "files/src/a.py"), "utf8")).toBe("a-CHANGED")
    expect(readFileSync(join(root, "src/a.py"), "utf8")).toBe("a-original")
  })

  test("용량 제한을 넘으면 우선 파일만 백업하고, 나머지는 되돌릴 수 없다고 알린다", () => {
    const root = work()
    const b = createBackup(root, join(root, ".batch/backup/current"), { maxBytes: 5, priority: ["src/a.py"] })
    expect(b.partial).toBe(true)
    expect(b.copiedFiles).toBe(1)
    expect(b.notBackedUp.sort()).toEqual(["keep.txt", "src/b.py"])
    writeFileSync(join(root, "src/a.py"), "x")
    writeFileSync(join(root, "src/b.py"), "y")
    const r = restoreFromBackup(root, b)
    expect(r.restored).toEqual(["src/a.py"])
    expect(r.unrestorable).toEqual(["src/b.py"])
  })

  test("일부 경로만 되돌릴 수 있다 (범위 밖 변경 되돌리기)", () => {
    const root = work()
    const b = createBackup(root, join(root, ".batch/backup/current"), { maxBytes: 1_000_000 })
    writeFileSync(join(root, "src/a.py"), "keep-this-change")
    writeFileSync(join(root, "keep.txt"), "revert-this")
    restoreFromBackup(root, b, (p) => p === "keep.txt")
    expect(readFileSync(join(root, "src/a.py"), "utf8")).toBe("keep-this-change")
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep")
  })

  test("백업은 .batch 폴더 안에 있어도 스냅샷에 포함되지 않는다", () => {
    const root = work()
    const b = createBackup(root, join(root, ".batch/backup/current"), { maxBytes: 1_000_000 })
    expect(Object.keys(b.snapshot).some((p) => p.startsWith(".batch"))).toBe(false)
    expect(readdirSync(join(root, ".batch/backup/current/files")).sort()).toEqual(["keep.txt", "src"])
  })
})

describe("밤 모드 상태", () => {
  const mk = (root: string): NightState => ({
    version: 1,
    planHash: "h",
    startedAt: new Date().toISOString(),
    deadline: new Date().toISOString(),
    status: "running",
    order: ["T1", "T2", "T3"],
    tasks: { T1: newTaskState("T1", "하나"), T2: newTaskState("T2", "둘"), T3: newTaskState("T3", "셋") },
    events: [],
  })

  test("저장하고 읽는다 (원자적 쓰기 후 임시 파일이 남지 않음)", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-ns-"))
    const layout = layoutFor(root)
    expect(loadNightState(layout)).toBeNull()
    const s = mk(root)
    s.tasks.T1!.status = "done"
    saveNightState(layout, s)
    expect(loadNightState(layout)!.tasks.T1!.status).toBe("done")
    expect(readdirSync(layout.batch).filter((f) => f.includes(".tmp-"))).toEqual([])
  })

  test("손상된 파일은 없는 것으로 본다", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-ns-"))
    const layout = layoutFor(root)
    mkdirSync(layout.batch, { recursive: true })
    writeFileSync(nightStatePath(layout), "{깨짐")
    expect(loadNightState(layout)).toBeNull()
  })

  test("이어받기: 실행 중이던 작업은 대기로, 옵션이 있으면 보류 작업도 다시 시도", () => {
    const s = mk("x")
    s.tasks.T1!.status = "done"
    s.tasks.T2!.status = "running"
    s.tasks.T3!.status = "held"
    s.tasks.T3!.reason = "검증 실패"
    const notes = prepareResume(s, { retryHeld: false })
    expect(s.tasks.T2!.status as string).toBe("pending")
    expect(s.tasks.T3!.status).toBe("held")
    expect(notes.length).toBe(1)
    prepareResume(s, { retryHeld: true })
    expect(s.tasks.T3!.status as string).toBe("pending")
    expect(s.tasks.T3!.reason).toBeUndefined()
    expect(s.tasks.T1!.status).toBe("done")
  })

  test("알림은 최근 500개만 보관한다", () => {
    const s = mk("x")
    for (let i = 0; i < 520; i++) addEvent(s, `e${i}`)
    expect(s.events.length).toBe(500)
    expect(s.events[0]!.message).toBe("e20")
  })
})
