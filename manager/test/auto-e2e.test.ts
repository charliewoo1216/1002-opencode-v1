// 오토 모드 end-to-end: 판단 -> 실제 낮/밤 실행 (원본 opencode + 모의 LLM)
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "../src/args"
import { cmdAuto } from "../src/cli-auto"
import { layoutFor } from "../src/paths"
import { approvePlan, intentPath, tasksPath } from "../src/plan"
import { startMockLlm } from "./mock-llm"
import { OPENCODE_AVAILABLE, OPENCODE_CMD } from "./helpers"

const suite = OPENCODE_AVAILABLE ? describe : describe.skip
const mock = startMockLlm(0)
afterAll(() => mock.stop())
process.env.OPENCODE_TEST_HOME = mkdtempSync(join(tmpdir(), "ocx-auto-home-"))

function project(withPlan = false) {
  const work = mkdtempSync(join(tmpdir(), "ocx-auto-"))
  const cfgFile = join(work, "ocx.config.json")
  writeFileSync(
    cfgFile,
    JSON.stringify({
      opencode: { command: OPENCODE_CMD },
      models: { big: { baseURL: `${mock.url}/v1`, model: "big-model" } },
      defaultModel: "big",
      day: { lightBody: { chat_template_kwargs: { enable_thinking: false } } },
      night: { maxAttempts: 1, maxFixRounds: 0, streamIdleSeconds: 30, firstTokenWaitSeconds: 30, attemptBudgetMinutes: 2, verifyTimeoutMinutes: 1, taskBudgetMinutes: 5 },
      auto: { minSamples: 3 },
    }),
  )
  const layout = layoutFor(work)
  if (withPlan) {
    mkdirSync(layout.plan, { recursive: true })
    writeFileSync(intentPath(layout), "# 의도\n## 목적\n파일 생성\n## 범위\n- 생성\n## 비목표\n- 수정\n## 전체 완료 기준\n- 통과\n## 열린 질문\n없음\n")
    writeFileSync(tasksPath(layout), "# 계획\n## 작업 T1: 작업 T1\n- 유형: 구현\n- 설명: a.txt를 만든다\n- 대상 파일: `a.txt`\n- 의존: 없음\n- 검증 명령: `grep -q ok a.txt`\n- 완료 기준:\n  - ok\n")
    expect(approvePlan(layout).ok).toBe(true)
  }
  return { work, cfgFile, layout }
}

async function auto(args: string[], env: { human: boolean; now?: Date }) {
  const err: string[] = []
  const out: string[] = []
  const oe = console.error
  const ol = console.log
  console.error = (m: string) => void err.push(String(m))
  console.log = (m: string) => void out.push(String(m))
  try {
    return { code: await cmdAuto(parseArgs(["auto", ...args]), env), err: err.join("\n"), out: out.join("\n") }
  } finally {
    console.error = oe
    console.log = ol
  }
}

const slowMetric = (minutesAgo: number) => ({
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), hour: 0, model: "big", mode: "day", durationMs: 1, firstEventMs: 1, firstTextMs: 1,
  endedBy: "exit", exitCode: 0, toolCalls: 0, steps: 1, inputTokens: 0, outputTokens: 0, outputChars: 0,
  llm: { requests: 1, firstTokenMs: 60_000, tokensPerSec: 2, promptTokens: 1, completionTokens: 1, errors: 0, clientAborted: 0 },
})

beforeEach(() => {
  Object.assign(mock.control, { hang: false, hangNext: 0, hangOnMain: 0, repeatToolCalls: 0, toolCall: null, firstTokenDelayMs: 0, replyText: "작업을 마쳤습니다." })
  mock.control.toolRules = []
  mock.control.rules = [{ match: "점검하세요", text: "점검결과: 통과" }]
})

suite("ocx auto (원본 opencode + 모의 LLM)", () => {
  test("사람이 지시문을 주면 낮 동작으로 실행하고 판단을 기록한다", async () => {
    const { work, cfgFile, layout } = project()
    const r = await auto(["--config", cfgFile, "--dir", work, "README 정리해줘"], { human: true })
    expect(r.code).toBe(0)
    expect(r.err).toContain("[auto] 판단: 낮(지시문 감독 실행)")
    expect(r.out).toContain("작업을 마쳤습니다.")
    expect(JSON.parse(readFileSync(join(layout.batch, "auto-state.json"), "utf8")).lastAction).toBe("day(instruction)")
    expect(existsSync(join(layout.batch, "day-state.json"))).toBe(true)
  }, 90000)

  test("서버가 느렸다는 기록이 있으면 가볍게 실행한다 (사고 모드 해제 필드가 요청에 붙는다)", async () => {
    const { work, cfgFile, layout } = project()
    mkdirSync(layout.batch, { recursive: true })
    writeFileSync(layout.metricsFile, [10, 20, 30, 40].map((m) => JSON.stringify(slowMetric(m))).join("\n") + "\n")
    const before = mock.logs.length
    const r = await auto(["--config", cfgFile, "--dir", work, "느린 서버 테스트"], { human: true })
    expect(r.code).toBe(0)
    expect(r.err).toContain("가볍게")
    expect(r.err).toContain("느림")
    const main = mock.logs.slice(before).filter((l) => l.hasTools)
    expect((main[0]!.body as any).chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(JSON.parse(readFileSync(join(layout.batch, "auto-state.json"), "utf8")).lastLevel).toBe("slow")
  }, 90000)

  test("무인 상태에서 승인된 계획서가 없으면 시작하지 않는다", async () => {
    const { work, cfgFile } = project()
    const before = mock.logs.length
    const r = await auto(["--config", cfgFile, "--dir", work], { human: false })
    expect(r.code).toBe(2)
    expect(r.err).toContain("시작하지 않음")
    expect(r.err).toContain("승인된 계획서가 필요합니다")
    expect(mock.logs.length).toBe(before)
  }, 60000)

  test("무인 상태에서 지시문만 줘도 시작하지 않는다", async () => {
    const { work, cfgFile } = project()
    const r = await auto(["--config", cfgFile, "--dir", work, "몰래 실행"], { human: false })
    expect(r.code).toBe(2)
    expect(r.err).toContain("즉석 지시문을 실행할 수 없습니다")
  }, 60000)

  test("무인 + 승인된 계획서면 밤 동작으로 끝까지 진행한다", async () => {
    const { work, cfgFile, layout } = project(true)
    mock.control.toolRules = [{ match: "[이번 작업] T1:", name: "bash", args: { command: "echo ok > a.txt", description: "작성" } }]
    const r = await auto(["--config", cfgFile, "--dir", work, "--now"], { human: false })
    expect(r.err).toContain("[auto] 판단: 밤")
    expect(r.code).toBe(0)
    expect(readFileSync(join(work, "a.txt"), "utf8").trim()).toBe("ok")
    expect(JSON.parse(readFileSync(join(layout.batch, "night-state.json"), "utf8")).endReason).toBe("all-done")
  }, 120000)

  test("--status는 실행하지 않고 판단만 보여 준다", async () => {
    const { work, cfgFile, layout } = project(true)
    const before = mock.logs.length
    const r = await auto(["--config", cfgFile, "--dir", work, "--status"], { human: false })
    expect(r.code).toBe(0)
    expect(r.err).toContain("[auto] 판단: 밤")
    expect(r.err).toContain("--status")
    expect(mock.logs.length).toBe(before)
    expect(existsSync(join(layout.batch, "auto-state.json"))).toBe(false) // 기록도 남기지 않는다
  }, 60000)

  test("--mode 값이 잘못되면 안내한다", async () => {
    const { work, cfgFile } = project()
    const r = await auto(["--config", cfgFile, "--dir", work, "--mode", "저녁"], { human: true })
    expect(r.code).toBe(2)
    expect(r.err).toContain("day 또는 night")
  }, 30000)

  test("--mode night로 지정해도 승인된 계획서가 없으면 시작하지 않는다", async () => {
    const { work, cfgFile } = project()
    const r = await auto(["--config", cfgFile, "--dir", work, "--mode", "night"], { human: true })
    expect(r.code).toBe(2)
    expect(r.err).toContain("밤 모드는 승인된 계획서가 필요합니다")
  }, 30000)
})
