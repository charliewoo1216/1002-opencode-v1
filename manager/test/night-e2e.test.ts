// 밤 모드 end-to-end: 실제 원본 opencode + 모의 LLM + `ocx night`
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
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
process.env.OPENCODE_TEST_HOME = mkdtempSync(join(tmpdir(), "ocx-night-home-"))

const INTENT = "# 의도\n## 목적\n파일 생성 작업\n## 범위\n- 파일 생성\n## 비목표\n- 기존 파일 수정\n## 전체 완료 기준\n- 검증 통과\n## 열린 질문\n없음\n"
const task = (id: string, file: string, o: { dep?: string; verify?: string } = {}) => `
## 작업 ${id}: 작업 ${id}
- 유형: 구현
- 설명: ${file} 파일을 만든다
- 대상 파일: \`${file}\`
- 의존: ${o.dep ?? "없음"}
- 검증 명령: \`${o.verify ?? `grep -q ok ${file}`}\`
- 완료 기준:
  - ${file}에 ok가 들어 있다
`

function project(tasksMd: string, night: Record<string, unknown> = {}) {
  const work = mkdtempSync(join(tmpdir(), "ocx-night-"))
  const cfgFile = join(work, "ocx.config.json")
  writeFileSync(
    cfgFile,
    JSON.stringify({
      opencode: { command: OPENCODE_CMD },
      models: { big: { baseURL: `${mock.url}/v1`, model: "big-model" } },
      defaultModel: "big",
      night: {
        maxAttempts: 1,
        streamIdleSeconds: 5,
        firstTokenWaitSeconds: 5,
        attemptBudgetMinutes: 2,
        maxFixRounds: 1,
        patienceInitialSeconds: 0.1,
        patienceMaxSeconds: 0.2,
        verifyTimeoutMinutes: 1,
        taskBudgetMinutes: 5,
        ...night,
      },
    }),
  )
  const layout = layoutFor(work)
  mkdirSync(layout.plan, { recursive: true })
  writeFileSync(intentPath(layout), INTENT)
  writeFileSync(tasksPath(layout), `# 계획${tasksMd}`)
  expect(approvePlan(layout).ok).toBe(true)
  return { work, cfgFile, layout }
}

async function ocx(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const ol = console.log
  const oe = console.error
  console.log = (m: string) => void out.push(String(m))
  console.error = (m: string) => void err.push(String(m))
  try {
    return { code: await main(args), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = ol
    console.error = oe
  }
}

const say = (file: string, content: string) => ({ name: "bash", args: { command: `echo ${content} > ${file}`, description: "파일 작성" } })

beforeEach(() => {
  Object.assign(mock.control, { hang: false, hangNext: 0, hangOnMain: 0, repeatToolCalls: 0, toolCall: null, firstTokenDelayMs: 0, replyText: "작업을 마쳤습니다." })
  mock.control.toolRules = []
  mock.control.rules = [{ match: "점검하세요", text: "각 기준을 확인했습니다.\n점검결과: 통과" }]
})

suite("ocx night (원본 opencode + 모의 LLM)", () => {
  test("서버 장애를 기다려 넘기고, 검증 실패 작업은 보류·복원하고, 의존 작업은 건너뛴다", async () => {
    const { work, cfgFile, layout } = project(task("T1", "a.txt") + task("T2", "b.txt", { dep: "T1" }) + task("T3", "c.txt") + task("T4", "d.txt", { dep: "T3" }))
    mock.control.toolRules = [
      { match: "[이번 작업] T1:", ...say("a.txt", "ok") },
      { match: "[이번 작업] T2:", ...say("b.txt", "ok") },
      { match: "[이번 작업] T3:", ...say("c.txt", "bad") }, // 검증(grep ok)에 실패하는 결과를 계속 만든다
      { match: "[이번 작업] T4:", ...say("d.txt", "ok") },
    ]
    mock.control.hangNext = 1 // 첫 작업의 첫 본 요청이 멈춤 -> 감독 실행이 보류 -> 기다렸다 재시도

    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--now"])
    expect(r.code).toBe(3)
    expect(r.err).toContain("서버 응답 문제로")

    const state = JSON.parse(readFileSync(join(layout.batch, "night-state.json"), "utf8"))
    const st = (id: string) => state.tasks[id]
    expect(state.status).toBe("finished")
    expect(state.endReason).toBe("all-held")
    expect([st("T1").status, st("T2").status, st("T3").status, st("T4").status]).toEqual(["done", "done", "held", "skipped"])
    expect(st("T1").verification).toBe("passed")
    expect(st("T1").selfCheck).toBe("pass")
    expect(st("T1").waitedMs).toBeGreaterThan(0)
    expect(st("T3").reason).toContain("검증 실패")
    expect(st("T4").reason).toContain("T3")

    // 파일 상태: 완료한 작업의 결과는 남고, 보류한 작업의 변경은 되돌려졌다(보관본은 따로 있음)
    expect(readFileSync(join(work, "a.txt"), "utf8").trim()).toBe("ok")
    expect(readFileSync(join(work, "b.txt"), "utf8").trim()).toBe("ok")
    expect(existsSync(join(work, "c.txt"))).toBe(false)
    expect(existsSync(join(work, "d.txt"))).toBe(false)
    expect(readFileSync(join(layout.batch, "held/T3/files/c.txt"), "utf8").trim()).toBe("bad")

    // 리포트
    const report = readFileSync(join(layout.batch, "report.md"), "utf8")
    expect(report).toContain("완료 2")
    expect(report).toContain("보류 1")
    expect(report).toContain("T3")
    const shown = await ocx(["report", "--dir", work])
    expect(shown.code).toBe(0)
    expect(shown.out).toContain("야간 작업 리포트")

    // 속도 기록은 night 모드로 남는다
    const metrics = readFileSync(join(layout.batch, "metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(metrics.some((m) => m.mode === "night")).toBe(true)
  }, 240000)

  test("작업 지시문에는 의도·비목표가 매번 들어가고, 점검 에이전트는 읽기 전용이다", async () => {
    const { work, cfgFile } = project(task("T1", "a.txt"))
    mock.control.toolRules = [{ match: "[이번 작업] T1:", ...say("a.txt", "ok") }]
    const before = mock.logs.length
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--now"])
    expect(r.code).toBe(0)
    const reqs = mock.logs.slice(before)
    const impl = reqs.find((l) => l.hasTools && l.lastUserText.includes("[이번 작업] T1:"))!
    expect(impl.lastUserText).toContain("[비목표]")
    expect(impl.lastUserText).toContain("기존 파일 수정")
    const check = reqs.find((l) => l.systemText.includes("완료 기준 점검자"))!
    expect(check.toolNames).toContain("read")
    for (const t of ["edit", "write", "bash"]) expect(check.toolNames).not.toContain(t)
  }, 120000)

  test("검증 명령에 git이 있으면 실행하지 않고 보류한다 (Git 금지)", async () => {
    const { work, cfgFile, layout } = project(task("T1", "a.txt", { verify: "git status" }), { maxFixRounds: 0 })
    mock.control.toolRules = [{ match: "[이번 작업] T1:", ...say("a.txt", "ok") }]
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--now"])
    expect(r.code).toBe(3)
    const state = JSON.parse(readFileSync(join(layout.batch, "night-state.json"), "utf8"))
    expect(state.tasks.T1.status).toBe("held")
    expect(state.tasks.T1.verifyRuns[0].summary).toContain("허용되지 않은 명령")
  }, 120000)

  test("모델이 도구로 git을 실행하려 해도 원본 권한 규칙이 막는다", async () => {
    const { work, cfgFile, layout } = project(task("T1", "a.txt"), { maxFixRounds: 0 })
    mock.control.toolRules = [{ match: "[이번 작업] T1:", name: "bash", args: { command: "FOO=1 git init && echo ok > a.txt", description: "git 시도" } }]
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--now"])
    expect(existsSync(join(work, ".git"))).toBe(false) // git init이 실행되지 않았다
    expect(existsSync(join(work, "a.txt"))).toBe(false)
    const state = JSON.parse(readFileSync(join(layout.batch, "night-state.json"), "utf8"))
    expect(state.tasks.T1.status).toBe("held")
    expect(r.code).toBe(3)
  }, 120000)

  test("승인되지 않았거나 계획서가 바뀌었으면 시작하지 않는다", async () => {
    const { work, cfgFile, layout } = project(task("T1", "a.txt"))
    writeFileSync(tasksPath(layout), readFileSync(tasksPath(layout), "utf8") + "\n## 작업 T2: 몰래 추가\n- 유형: 분석\n- 설명: x\n- 완료 기준: y\n")
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--now"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("승인된 계획서가 필요합니다")
  }, 60000)

  test("--dry-run은 일정과 작업 순서만 보여 주고 실행하지 않는다", async () => {
    const { work, cfgFile } = project(task("T1", "a.txt") + task("T2", "b.txt", { dep: "T1" }), {})
    const before = mock.logs.length
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--until", "06:30", "--dry-run"])
    expect(r.code).toBe(0)
    expect(r.err).toContain("T1 -> T2")
    expect(r.err).toContain("종료 예정")
    expect(mock.logs.length).toBe(before)
  }, 60000)

  test("잘못된 시각 옵션은 안내하고 끝낸다", async () => {
    const { work, cfgFile } = project(task("T1", "a.txt"))
    const r = await ocx(["night", "--config", cfgFile, "--dir", work, "--until", "25:99", "--dry-run"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("시각")
  }, 60000)
})
