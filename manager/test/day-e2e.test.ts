// 낮 모드 end-to-end: 실제 원본 opencode + 모의 LLM + `ocx day`
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli"
import { startMockLlm } from "./mock-llm"
import { OPENCODE_AVAILABLE, OPENCODE_CMD } from "./helpers"

const suite = OPENCODE_AVAILABLE ? describe : describe.skip

const mock = startMockLlm(0)
afterAll(() => mock.stop())

process.env.OPENCODE_TEST_HOME = mkdtempSync(join(tmpdir(), "ocx-day-home-"))

function workdir(day: Record<string, unknown> = {}) {
  const work = mkdtempSync(join(tmpdir(), "ocx-day-"))
  const cfgFile = join(work, "ocx.config.json")
  writeFileSync(
    cfgFile,
    JSON.stringify({
      opencode: { command: OPENCODE_CMD },
      models: { big: { baseURL: `${mock.url}/v1`, model: "big-model" } },
      defaultModel: "big",
      day: { streamIdleSeconds: 5, firstTokenWaitSeconds: 5, attemptBudgetMinutes: 2, maxAttempts: 3, lightBody: { chat_template_kwargs: { enable_thinking: false } }, ...day },
    }),
  )
  return { work, cfgFile }
}

async function ocx(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const ol = console.log
  const oe = console.error
  console.log = (m: string) => void out.push(String(m))
  console.error = (m: string) => void err.push(String(m))
  try {
    const code = await main(args)
    return { code, out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = ol
    console.error = oe
  }
}

const mainReqs = (from: number) => mock.logs.slice(from).filter((l) => l.hasTools)

beforeEach(() => {
  mock.control.hang = false
  mock.control.hangNext = 0
  mock.control.hangOnMain = 0
  mock.control.repeatToolCalls = 0
  mock.control.toolCall = null
  mock.control.replyText = "작업을 마쳤습니다."
  mock.control.rules = []
})

suite("ocx day (원본 opencode + 모의 LLM)", () => {
  test("정상 실행: 한 번에 끝나고 상태와 속도 기록을 남긴다", async () => {
    const { work, cfgFile } = workdir()
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "README를 정리해줘"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("작업을 마쳤습니다.")
    expect(r.err).toContain("완료: 시도 1회")
    const state = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(state.status).toBe("done")
    expect(state.attempts.length).toBe(1)
    const metrics = readFileSync(join(work, ".batch/metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(metrics[0].mode).toBe("day")
    expect(metrics[0].llm.requests).toBeGreaterThanOrEqual(1)
  }, 90000)

  test("첫 이벤트 전에 응답이 멈추면 새 세션으로 다시 시작하고, 두 번째부터 가볍게 실행한다", async () => {
    const { work, cfgFile } = workdir()
    mock.control.hangNext = 1 // 본 요청 1개만 멈춤
    const before = mock.logs.length
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "정체 테스트"])
    expect(r.code).toBe(0)
    expect(r.err).toContain("시도 1 중단: 첫 토큰을 5초 넘게 기다림")
    expect(r.err).toContain("새 세션으로 이어갑니다") // 세션 ID가 아직 없어 이어하기 불가
    const state = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(state.attempts.map((a: any) => [a.kind, a.light, a.endedBy])).toEqual([
      ["fresh", false, "stall"],
      ["fresh", true, "exit"],
    ])
    // 가볍게 실행: 두 번째 시도의 본 요청에만 사고 모드 해제 필드가 붙는다
    const reqs = mainReqs(before)
    expect((reqs[0]!.body as any).chat_template_kwargs).toBeUndefined()
    expect((reqs.at(-1)!.body as any).chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(reqs.at(-1)!.lastUserText).toContain("원래 지시")
    expect(reqs.at(-1)!.lastUserText).toContain("정체 테스트")
  }, 120000)

  test("작업 도중 응답이 멈추면 같은 세션으로 이어서 진행한다", async () => {
    const { work, cfgFile } = workdir()
    mock.control.toolCall = { name: "bash", args: { command: "echo step1 > step1.txt", description: "1단계" } }
    mock.control.hangOnMain = 2 // 도구 호출(1번째) 뒤 두 번째 본 요청에서 멈춤
    const before = mock.logs.length
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "이어하기 테스트"])
    expect(r.code).toBe(0)
    expect(r.err).toContain("같은 세션으로 이어서 진행합니다")
    const state = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(state.attempts.map((a: any) => [a.kind, a.endedBy])).toEqual([
      ["fresh", "stall"],
      ["continue", "exit"],
    ])
    expect(state.attempts[1].sessionID).toBe(state.attempts[0].sessionID)
    expect(state.changedFiles).toContain("step1.txt") // 이미 한 작업은 파일에 남아 있다
    expect(mainReqs(before).at(-1)!.lastUserText).toContain("이어서 계속하세요")
  }, 120000)

  test("같은 도구 호출이 반복되면 루프로 끊고 새 세션으로 이어간다", async () => {
    const { work, cfgFile } = workdir()
    mock.control.toolCall = { name: "bash", args: { command: "echo loop >> loop.txt", description: "반복" } }
    mock.control.repeatToolCalls = 5
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "루프 테스트"])
    expect(r.err).toContain("같은 도구 호출(bash)")
    expect(r.err).toContain("반복을 끊기 위해 새 세션으로 이어갑니다")
    const state = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(state.attempts[0].endedBy).toBe("loop")
    expect(state.attempts[1].kind).toBe("fresh")
    expect(state.changedFiles).toContain("loop.txt") // 바뀐 파일을 추적한다
    expect(r.code).toBe(0)
  }, 120000)

  test("계속 실패하면 보류하고, --resume으로 이어서 끝낸다", async () => {
    const { work, cfgFile } = workdir({ maxAttempts: 2 })
    mock.control.hang = true
    const first = await ocx(["day", "--config", cfgFile, "--dir", work, "보류 테스트"])
    expect(first.code).toBe(3)
    expect(first.err).toContain("보류")
    expect(first.err).toContain("ocx day --resume")
    const held = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(held.status).toBe("held")
    expect(held.attempts.length).toBe(2)

    mock.control.hang = false
    const again = await ocx(["day", "--config", cfgFile, "--dir", work, "--resume"])
    expect(again.code).toBe(0)
    const done = JSON.parse(readFileSync(join(work, ".batch/day-state.json"), "utf8"))
    expect(done.status).toBe("done")
    expect(done.attempts.length).toBe(3) // 이전 2회 + 재개 1회
    expect(done.goal).toBe("보류 테스트")
  }, 180000)

  test("--task는 승인된 계획서가 있어야 하고, 작업 정보와 의도를 지시문에 담는다", async () => {
    const { work, cfgFile } = workdir()
    const noPlan = await ocx(["day", "--config", cfgFile, "--dir", work, "--task", "T1"])
    expect(noPlan.code).toBe(2)
    expect(noPlan.err).toContain("승인된 계획서가 필요합니다")

    // 계획서 작성 + 승인
    const { mkdirSync } = await import("node:fs")
    const { layoutFor } = await import("../src/paths")
    const { approvePlan, intentPath, tasksPath } = await import("../src/plan")
    const layout = layoutFor(work)
    mkdirSync(layout.plan, { recursive: true })
    writeFileSync(intentPath(layout), "# 의도\n## 목적\n로그인 개선\n## 범위\n- 검증\n## 비목표\n- UI 변경\n## 전체 완료 기준\n- 통과\n## 열린 질문\n없음\n")
    writeFileSync(tasksPath(layout), "# 작업\n## 작업 T1: 검증 추가\n- 유형: 구현\n- 설명: 검증을 추가한다\n- 대상 파일: `a.py`\n- 의존: 없음\n- 검증 명령: `python -m pytest`\n- 완료 기준:\n  - 통과한다\n")
    expect(approvePlan(layout).ok).toBe(true)

    const before = mock.logs.length
    const ok = await ocx(["day", "--config", cfgFile, "--dir", work, "--task", "T1"])
    expect(ok.code).toBe(0)
    const prompt = mainReqs(before)[0]!.lastUserText
    expect(prompt).toContain("[비목표]")
    expect(prompt).toContain("UI 변경")
    expect(prompt).toContain("T1: 검증 추가")
    expect(prompt).toContain("python -m pytest")

    const missing = await ocx(["day", "--config", cfgFile, "--dir", work, "--task", "T9"])
    expect(missing.code).toBe(2)
    expect(missing.err).toContain("T9")
  }, 180000)

  test("지시문 없이 실행하면 원본 화면을 프록시 주소로 띄운다", async () => {
    const work = mkdtempSync(join(tmpdir(), "ocx-day-tui-"))
    const cfgFile = join(work, "ocx.config.json")
    writeFileSync(
      cfgFile,
      JSON.stringify({
        opencode: { command: ["bun", "run", join(import.meta.dir, "fake-opencode.ts")] },
        models: { big: { baseURL: "http://upstream.example:8000/v1", model: "big-model" } },
        defaultModel: "big",
      }),
    )
    const argsFile = join(work, "args.json")
    process.env.FAKE_ARGS_FILE = argsFile
    try {
      const r = await ocx(["day", "--config", cfgFile, "--dir", work])
      expect(r.code).toBe(0)
    } finally {
      delete process.env.FAKE_ARGS_FILE
    }
    const rec = JSON.parse(readFileSync(argsFile, "utf8"))
    expect(rec.args).toEqual(["-m", "big/big-model"]) // run 없이 화면을 띄움
    const conf = JSON.parse(rec.env.OPENCODE_CONFIG_CONTENT)
    expect(conf.provider.big.options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/big$/) // 프록시 경유
    expect(conf.permission.webfetch).toBe("deny")
    expect(conf.permission.bash["git *"]).toBe("deny") // 안전 규칙이 화면 실행에도 적용된다
    expect(rec.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  }, 60000)

  test("--auto(권한 자동 승인)로 실행해도 작업 폴더 밖 읽기·쓰기는 막힌다", async () => {
    const { work, cfgFile } = workdir()
    const outside = mkdtempSync(join(tmpdir(), "ocx-outside-"))
    mock.control.toolCall = { name: "write", args: { filePath: join(outside, "leak.txt"), content: "유출" } }
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "--auto", "폴더 밖에 쓰기 시도"])
    expect(r.code).toBe(0) // 도구가 거부되어도 실행 자체는 끝난다
    expect(existsSync(join(outside, "leak.txt"))).toBe(false)
  }, 90000)

  test("설정의 추가 금지 명령(safety.extraBlocked)이 원본 권한 규칙으로 적용된다", async () => {
    const { work, cfgFile } = workdir()
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"))
    cfg.safety = { extraBlocked: ["touch"] }
    writeFileSync(cfgFile, JSON.stringify(cfg))
    mock.control.toolCall = { name: "bash", args: { command: "touch blocked.txt && echo ok > allowed.txt", description: "금지 명령 시도" } }
    const r = await ocx(["day", "--config", cfgFile, "--dir", work, "추가 금지 명령 테스트"])
    expect(r.code).toBe(0)
    expect(existsSync(join(work, "blocked.txt"))).toBe(false)
    expect(existsSync(join(work, "allowed.txt"))).toBe(false) // 복합 명령 전체가 거부된다
  }, 90000)
})
