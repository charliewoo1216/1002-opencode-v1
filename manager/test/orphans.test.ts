import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { killAllChildren, reapOrphans, setChildRegistry, trackChild, untrackChild } from "../src/runner"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return true
}
const waitDead = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50)
  return !alive(pid)
}

describe("고아 프로세스 정리", () => {
  test("등록부에 남은 살아 있는 프로세스를 정리하고, 같은 프로그램일 때만 죽인다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-or-"))
    const file = join(dir, "children.json")
    const victim = spawn("sleep", ["71"], { detached: true, stdio: "ignore" })
    const bystander = spawn("sleep", ["72"], { detached: true, stdio: "ignore" })
    try {
      writeFileSync(
        file,
        JSON.stringify([
          { pid: victim.pid, command: "sleep", cmdline: "sleep 71" },
          { pid: bystander.pid, command: "other", cmdline: "other-program --flag" }, // pid가 재사용된 경우를 흉내: 명령이 다름
          { pid: 999_999, command: "sleep", cmdline: "sleep 1" }, // 이미 없는 프로세스
        ]),
      )
      expect(reapOrphans(file)).toBe(1)
      expect(await waitDead(victim.pid!)).toBe(true)
      expect(alive(bystander.pid!)).toBe(true) // 다른 프로그램은 건드리지 않는다
      expect(readFileSync(file, "utf8")).toBe("[]")
    } finally {
      try {
        process.kill(-bystander.pid!, "SIGKILL")
      } catch {}
    }
  })

  test("등록부 파일이 없거나 깨져 있어도 안전하다", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-or-"))
    expect(reapOrphans(join(dir, "none.json"))).toBe(0)
    const broken = join(dir, "broken.json")
    writeFileSync(broken, "{깨짐")
    expect(reapOrphans(broken)).toBe(0)
  })

  test("실행 중인 자식은 등록부에 기록되고 끝나면 지워진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-or-"))
    const file = join(dir, "children.json")
    setChildRegistry(file)
    try {
      trackChild(424242, "bun", ["run", "x.ts"])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ pid: 424242, command: "bun", cmdline: "bun run x.ts" }])
      untrackChild(424242)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([])
    } finally {
      killAllChildren()
      setChildRegistry(null)
    }
  })
})
