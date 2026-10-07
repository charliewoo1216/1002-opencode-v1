import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TimeError, deadlineFor, inWindow, msUntilWindowOpens, nextOccurrence, parseClock } from "../src/schedule"
import { runCommand, runVerify } from "../src/verify"

const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m, 0, 0)

describe("시간 계산", () => {
  test("시각 파싱과 오류", () => {
    expect(parseClock("07:00")).toBe(420)
    expect(parseClock("7:05")).toBe(425)
    expect(() => parseClock("25:00")).toThrow(TimeError)
    expect(() => parseClock("abc")).toThrow("시각 형식")
  })

  test("다음에 오는 시각 (같은 시각이면 다음 날)", () => {
    expect(nextOccurrence(at(23), "07:00")).toEqual(at(7, 0, 8))
    expect(nextOccurrence(at(3), "07:00")).toEqual(at(7, 0, 7))
    expect(nextOccurrence(at(7), "07:00")).toEqual(at(7, 0, 8))
  })

  test("자정을 넘는 야간 창", () => {
    expect(inWindow(at(19), "19:00", "07:00")).toBe(true)
    expect(inWindow(at(23, 30), "19:00", "07:00")).toBe(true)
    expect(inWindow(at(3), "19:00", "07:00")).toBe(true)
    expect(inWindow(at(7), "19:00", "07:00")).toBe(false)
    expect(inWindow(at(14), "19:00", "07:00")).toBe(false)
    expect(inWindow(at(10), "09:00", "18:00")).toBe(true) // 같은 날 구간
  })

  test("창이 열릴 때까지 기다릴 시간과 종료 시각", () => {
    expect(msUntilWindowOpens(at(17), "19:00", "07:00")).toBe(2 * 3600_000)
    expect(msUntilWindowOpens(at(20), "19:00", "07:00")).toBe(0)
    expect(deadlineFor(at(20), "07:00")).toEqual(at(7, 0, 8))
    expect(deadlineFor(at(2), "07:00")).toEqual(at(7, 0, 7))
  })
})

describe("검증 명령 실행", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ocx-vf-"))

  test("성공/실패와 출력, 종료 코드를 기록한다", async () => {
    const cwd = dir()
    const ok = await runCommand("echo hello", { cwd, timeoutMs: 10000 })
    expect(ok.exitCode).toBe(0)
    expect(ok.outputTail).toContain("hello")
    const bad = await runCommand("echo boom >&2; exit 3", { cwd, timeoutMs: 10000 })
    expect(bad.exitCode).toBe(3)
    expect(bad.outputTail).toContain("boom")
  })

  test("작업 폴더에서 실행한다", async () => {
    const cwd = dir()
    writeFileSync(join(cwd, "marker.txt"), "x")
    expect((await runCommand("test -f marker.txt", { cwd, timeoutMs: 10000 })).exitCode).toBe(0)
  })

  test("시간 제한을 넘으면 종료하고 표시한다", async () => {
    const r = await runCommand("sleep 30", { cwd: dir(), timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
    expect(r.durationMs).toBeLessThan(8000)
  })

  test("명령이 끝난 뒤 남은 백그라운드 프로세스를 정리한다", async () => {
    const cwd = dir()
    const pidFile = join(cwd, "bg.pid")
    // 백그라운드에서 오래 도는 프로세스를 띄우고 명령은 바로 끝난다
    await runCommand(`sleep 60 & echo $! > ${pidFile}`, { cwd, timeoutMs: 10000 })
    await Bun.sleep(300)
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number((await Bun.file(pidFile).text()).trim())
    // 종료됐지만 부모가 수거하지 않은 좀비(Z)는 이미 죽은 것으로 본다
    let alive = true
    try {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.charAt(0)
      alive = state !== "Z"
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  test("금지 명령은 실행하지 않고 사유를 남긴다", async () => {
    const r = await runVerify(["git commit -m x"], { cwd: dir(), timeoutMs: 1000, guard: (c) => (c.startsWith("git ") ? "git 명령은 허용되지 않음" : null) })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.blocked).toContain("git")
    expect(r.failureSummary).toContain("허용되지 않은 명령")
  })

  test("여러 명령은 처음 실패에서 멈추고 요약을 만든다", async () => {
    const cwd = dir()
    const r = await runVerify(["echo one", "echo two >&2; exit 1", "echo three"], { cwd, timeoutMs: 10000 })
    expect(r.ok).toBe(false)
    expect(r.results.length).toBe(2)
    expect(r.failureSummary).toContain("종료 코드 1")
    expect(r.failureSummary).toContain("two")
    const good = await runVerify(["echo a", "echo b"], { cwd, timeoutMs: 10000 })
    expect(good.ok).toBe(true)
    expect(good.failureSummary).toBe("")
  })
})
