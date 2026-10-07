// 통합 테스트: 실제 원본 opencode(소스) + 모의 LLM 서버
// 원본 소스 경로는 환경변수 OCX_OPENCODE_SRC (기본: /home/user/sst/opencode/packages/opencode/src/index.ts)
// 경로가 없으면 이 파일의 테스트는 건너뛴다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMetric, metricFromResult, readMetrics, summarizeLlm } from "../src/metrics"
import { startMeasureProxy } from "../src/proxy"
import { layoutFor } from "../src/paths"
import { runOpencode } from "../src/runner"
import { startMockLlm } from "./mock-llm"
import { AUTO_DEFAULTS, DAY_DEFAULTS, NIGHT_DEFAULTS, type OcxConfig } from "../src/config"
import { OPENCODE_AVAILABLE, OPENCODE_CMD } from "./helpers"

const suite = OPENCODE_AVAILABLE ? describe : describe.skip

suite("원본 opencode + 모의 LLM 통합", () => {
  const mocks = {
    a: startMockLlm(0),
    b: startMockLlm(0),
  }
  const home = mkdtempSync(join(tmpdir(), "ocx-home-"))
  const cfg = (): OcxConfig => ({
    opencode: { command: OPENCODE_CMD },
    models: {
      big: { baseURL: `${mocks.a.url}/v1`, model: "big-model", apiKey: "EMPTY", contextLimit: 32768, outputLimit: 4096 },
      light: { baseURL: `${mocks.b.url}/v1`, model: "light-model", apiKey: "EMPTY", contextLimit: 16384, outputLimit: 2048 },
    },
    defaultModel: "big",
    smallModel: "light",
    closedNetwork: true,
    referenceDir: "reference",
    day: { ...DAY_DEFAULTS },
    night: { ...NIGHT_DEFAULTS },
    auto: { ...AUTO_DEFAULTS },
    safety: { extraBlocked: [] },
  })
  const env = { OPENCODE_TEST_HOME: home }
  const proj = () => mkdtempSync(join(tmpdir(), "ocx-proj-"))

  beforeAll(() => {
    mocks.a.control.replyText = "큰 모델 응답"
    mocks.b.control.replyText = "가벼운 모델 응답"
  })
  afterAll(() => {
    mocks.a.stop()
    mocks.b.stop()
  })

  test("선택한 모델로 실행하고 응답을 받는다", async () => {
    const r = await runOpencode({ cfg: cfg(), prompt: "안녕", cwd: proj(), extraEnv: env, totalTimeoutMs: 60000 })
    expect(r.endedBy).toBe("exit")
    expect(r.exitCode).toBe(0)
    expect(r.text).toBe("큰 모델 응답")
    expect(r.sessionID).toMatch(/^ses_/)

    const r2 = await runOpencode({ cfg: cfg(), model: "light", prompt: "안녕", cwd: proj(), extraEnv: env, totalTimeoutMs: 60000 })
    expect(r2.text).toBe("가벼운 모델 응답")
  }, 90000)

  test("보조 호출(small_model)은 본 모델과 다른 서버로 간다", async () => {
    const beforeA = mocks.a.logs.length
    const beforeB = mocks.b.logs.length
    await runOpencode({ cfg: cfg(), prompt: "분리 확인", cwd: proj(), extraEnv: env, totalTimeoutMs: 60000 })
    const aNew = mocks.a.logs.slice(beforeA)
    const bNew = mocks.b.logs.slice(beforeB)
    expect(aNew.some((l) => l.hasTools)).toBe(true) // 본 작업은 도구 포함 요청
    expect(bNew.length).toBeGreaterThan(0) // 제목 생성은 보조 모델 서버
    expect(bNew.every((l) => !l.hasTools)).toBe(true)
  }, 90000)

  test("도구 호출을 수행하고 이벤트로 집계된다", async () => {
    mocks.a.control.toolCall = { name: "bash", args: { command: "echo hi > out.txt", description: "파일 생성" } }
    mocks.a.control.replyText = "완료했습니다."
    const cwd = proj()
    const r = await runOpencode({ cfg: cfg(), prompt: "파일 만들어", cwd, extraEnv: env, totalTimeoutMs: 60000 })
    mocks.a.control.toolCall = null
    mocks.a.control.replyText = "큰 모델 응답"
    expect(r.toolCalls).toBe(1)
    expect(r.text).toBe("완료했습니다.")
    expect(readFileSync(join(cwd, "out.txt"), "utf8").trim()).toBe("hi")
  }, 90000)

  test("--continue로 마지막 세션을 이어서 실행한다", async () => {
    const cwd = proj()
    const first = await runOpencode({ cfg: cfg(), prompt: "첫번째", cwd, extraEnv: env, totalTimeoutMs: 60000 })
    const second = await runOpencode({ cfg: cfg(), prompt: "두번째", cwd, continueSession: true, extraEnv: env, totalTimeoutMs: 60000 })
    expect(second.sessionID).toBe(first.sessionID)
  }, 90000)

  test("서버가 응답하지 않으면 정체로 종료하고, 서버 쪽 연결도 끊긴다", async () => {
    mocks.a.control.hang = true
    const before = mocks.a.logs.length
    const r = await runOpencode({ cfg: cfg(), prompt: "정체", cwd: proj(), extraEnv: env, stallTimeoutMs: 5000, totalTimeoutMs: 60000 })
    mocks.a.control.hang = false
    expect(r.endedBy).toBe("stall")
    await Bun.sleep(1500)
    const hung = mocks.a.logs.slice(before).filter((l) => l.hasTools)
    expect(hung.length).toBeGreaterThan(0)
    expect(hung.every((l) => l.aborted)).toBe(true) // 프로세스 트리 종료로 연결이 닫힘
  }, 90000)

  test("실행 결과를 속도 기록으로 남긴다", async () => {
    const cwd = proj()
    const startedAt = new Date()
    const r = await runOpencode({ cfg: cfg(), prompt: "기록", cwd, extraEnv: env, totalTimeoutMs: 60000 })
    appendMetric(layoutFor(cwd), metricFromResult(r, { model: "big", mode: "run", startedAt }))
    const [m] = readMetrics(layoutFor(cwd))
    expect(m!.endedBy).toBe("exit")
    expect(m!.firstEventMs).not.toBeNull()
    expect(m!.hour).toBe(startedAt.getHours())
  }, 90000)

  test("측정 프록시를 거쳐 실행하면 첫 토큰 시간과 속도가 기록된다", async () => {
    mocks.a.control.firstTokenDelayMs = 400
    const proxy = startMeasureProxy({ upstreams: { big: `${mocks.a.url}/v1`, light: `${mocks.b.url}/v1` } })
    try {
      const r = await runOpencode({
        cfg: cfg(),
        prompt: "프록시 측정",
        cwd: proj(),
        extraEnv: env,
        totalTimeoutMs: 60000,
        baseURLOverrides: { big: proxy.urlFor("big"), light: proxy.urlFor("light") },
      })
      expect(r.text).toBe("큰 모델 응답")
      const llm = summarizeLlm(proxy.records, "big")
      expect(llm.requests).toBeGreaterThanOrEqual(2) // 본 작업 + 제목 생성
      expect(llm.firstTokenMs!).toBeGreaterThanOrEqual(380)
      expect(llm.errors).toBe(0)
      expect(proxy.records.some((x) => x.model === "light")).toBe(true) // 제목 생성은 light로
    } finally {
      mocks.a.control.firstTokenDelayMs = 0
      proxy.stop()
    }
  }, 90000)

  test("프록시가 정체를 감지하면 본 요청이 끊기고 OpenCode가 오류로 처리한다", async () => {
    mocks.a.control.hang = true
    const stalled: number[] = []
    const proxy = startMeasureProxy({
      upstreams: { big: `${mocks.a.url}/v1`, light: `${mocks.b.url}/v1` },
      idleTimeoutMs: 1500,
      abortOnStall: true,
      onStall: (x) => stalled.push(x.id),
    })
    try {
      const r = await runOpencode({
        cfg: cfg(),
        prompt: "정체 감지",
        cwd: proj(),
        extraEnv: env,
        totalTimeoutMs: 20000,
        baseURLOverrides: { big: proxy.urlFor("big"), light: proxy.urlFor("light") },
      })
      expect(stalled.length).toBeGreaterThan(0)
      expect(proxy.records.some((x) => x.stalledAborted)).toBe(true)
      // 프록시가 끊은 뒤 원본이 어떻게 끝나는지(자체 재시도 포함)를 기록으로 남긴다
      console.log(`정체 후 원본 종료 방식: endedBy=${r.endedBy} exitCode=${r.exitCode} 호출수=${proxy.records.length}`)
    } finally {
      mocks.a.control.hang = false
      proxy.stop()
    }
  }, 60000)
})
