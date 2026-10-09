// 비정상 종료 복구: ocx를 별도 프로세스로 실행하고 kill -9 한 뒤, 다시 실행해 이어서 끝내는지 확인
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli"
import { layoutFor } from "../src/paths"
import { approvePlan, intentPath, tasksPath } from "../src/plan"
import { startMockLlm } from "./mock-llm"
import { OPENCODE_AVAILABLE, OPENCODE_CMD } from "./helpers"

const suite = OPENCODE_AVAILABLE ? describe : describe.skip
const mock = startMockLlm(0)
afterAll(() => mock.stop())

const alive = (pid: number) => {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.charAt(0)
    return state !== "Z"
  } catch {
    return false
  }
}
const until = async (cond: () => boolean, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(100)
  }
  return false
}

const task = (id: string, file: string, dep = "없음") => `
## 작업 ${id}: 작업 ${id}
- 유형: 구현
- 설명: ${file} 파일을 만든다
- 대상 파일: \`${file}\`
- 의존: ${dep}
- 검증 명령: \`grep -q ok ${file}\`
- 완료 기준:
  - ${file}에 ok가 들어 있다
`

suite("밤 모드 비정상 종료 복구", () => {
  test("kill -9 로 죽은 뒤 다시 실행하면 고아 프로세스를 정리하고 완료된 작업은 건너뛰고 이어서 끝낸다", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-crash-home-"))
    const work = mkdtempSync(join(tmpdir(), "ocx-crash-"))
    const cfgFile = join(work, "ocx.config.json")
    writeFileSync(
      cfgFile,
      JSON.stringify({
        opencode: { command: OPENCODE_CMD },
        models: { big: { baseURL: `${mock.url}/v1`, model: "big-model" } },
        defaultModel: "big",
        night: { maxAttempts: 1, streamIdleSeconds: 300, firstTokenWaitSeconds: 300, attemptBudgetMinutes: 5, maxFixRounds: 0, verifyTimeoutMinutes: 1, taskBudgetMinutes: 10 },
      }),
    )
    const layout = layoutFor(work)
    mkdirSync(layout.plan, { recursive: true })
    writeFileSync(intentPath(layout), "# 의도\n## 목적\n파일 생성\n## 범위\n- 생성\n## 비목표\n- 수정\n## 전체 완료 기준\n- 통과\n## 열린 질문\n없음\n")
    writeFileSync(tasksPath(layout), `# 계획${task("T1", "a.txt")}${task("T2", "b.txt", "T1")}`)
    expect(approvePlan(layout).ok).toBe(true)

    const say = (file: string) => ({ name: "bash", args: { command: `echo ok > ${file}`, description: "작성" } })
    mock.control.rules = [{ match: "점검하세요", text: "점검결과: 통과" }]
    mock.control.toolRules = [
      { match: "[이번 작업] T1:", ...say("a.txt") },
      { match: "[이번 작업] T2:", ...say("b.txt") },
    ]
    mock.control.delayRules = [{ match: "[이번 작업] T2:", ms: 120_000 }] // T2의 요청은 오래 걸린다

    // 1) 별도 프로세스로 실행
    const proc = spawn("bun", ["run", join(import.meta.dir, "../src/main.ts"), "night", "--config", cfgFile, "--dir", work, "--now"], {
      env: { ...process.env, OPENCODE_TEST_HOME: home },
      stdio: ["ignore", "ignore", "ignore"],
    })
    const statePath = join(layout.batch, "night-state.json")
    const registry = join(layout.batch, "children.json")
    const t2Started = await until(() => {
      try {
        const s = JSON.parse(readFileSync(statePath, "utf8"))
        return s.tasks.T1.status === "done" && s.tasks.T2.status === "running" && mock.logs.some((l) => l.hasTools && l.lastUserText.includes("[이번 작업] T2:"))
      } catch {
        return false
      }
    })
    expect(t2Started).toBe(true)
    expect(readFileSync(join(work, "a.txt"), "utf8").trim()).toBe("ok")

    // 등록부에 기록된 자식 프로세스(진행 중이던 opencode)
    const children: Array<{ pid: number }> = JSON.parse(readFileSync(registry, "utf8"))
    expect(children.length).toBeGreaterThan(0)

    // 2) 관리 프로그램만 강제 종료 (정상 종료 처리가 불가능한 상황)
    process.kill(proc.pid!, "SIGKILL")
    await Bun.sleep(500)
    expect(children.some((c) => alive(c.pid))).toBe(true) // 자식은 고아로 남아 있다

    // 3) 다시 실행: 고아 정리 + 이어서 진행
    mock.control.delayRules = []
    const t1RequestsBefore = mock.logs.filter((l) => l.hasTools && l.lastUserText.includes("[이번 작업] T1:")).length
    process.env.OPENCODE_TEST_HOME = home
    const err: string[] = []
    const oe = console.error
    console.error = (m: string) => void err.push(String(m))
    let code: number
    try {
      code = await main(["night", "--config", cfgFile, "--dir", work, "--now"])
    } finally {
      console.error = oe
    }
    expect(code).toBe(0)
    expect(err.join("\n")).toContain("이전 실행이 남긴 프로세스")
    expect(children.some((c) => alive(c.pid))).toBe(false) // 고아가 정리되었다

    const state = JSON.parse(readFileSync(statePath, "utf8"))
    expect(state.endReason).toBe("all-done")
    expect(state.tasks.T1.status).toBe("done")
    expect(state.tasks.T2.status).toBe("done")
    expect(readFileSync(join(work, "b.txt"), "utf8").trim()).toBe("ok")
    // T1은 다시 실행하지 않았다
    const t1Requests = mock.logs.filter((l) => l.hasTools && l.lastUserText.includes("[이번 작업] T1:")).length
    expect(t1Requests).toBe(t1RequestsBefore)
    expect(state.events.some((e: any) => e.message.includes("이전 실행이 도중에 끊겨"))).toBe(true)
  }, 240000)
})
