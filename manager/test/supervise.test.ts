import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DAY_DEFAULTS, type DayConfig } from "../src/config"
import { LoopDetector } from "../src/loopdetect"
import type { OpencodeEvent, RunResult } from "../src/runner"
import { diffSnapshots, takeSnapshot } from "../src/snapshot"
import { continuePrompt, failureReason, summaryPrompt, supervise, type AttemptOutcome, type AttemptSpec } from "../src/supervise"

const tool = (name: string, input: unknown, status = "completed", extra: Record<string, unknown> = {}): OpencodeEvent => ({
  type: "tool_use",
  part: { tool: name, state: { status, input, ...extra } },
})

describe("루프 감지", () => {
  test("같은 도구 호출이 연속으로 반복되면 알린다", () => {
    const d = new LoopDetector(3)
    expect(d.feed(tool("read", { p: 1 }))).toBeNull()
    expect(d.feed(tool("read", { p: 1 }))).toBeNull()
    expect(d.feed(tool("read", { p: 1 }))).toContain("3번 연속 반복")
  })

  test("다른 호출이 끼면 세기를 다시 시작하고, 진행 중 상태 이벤트는 세지 않는다", () => {
    const d = new LoopDetector(3)
    d.feed(tool("read", { p: 1 }))
    d.feed(tool("read", { p: 1 }))
    expect(d.feed(tool("grep", { q: "x" }))).toBeNull()
    expect(d.feed(tool("read", { p: 1 }))).toBeNull()
    expect(d.feed(tool("read", { p: 1 }, "running"))).toBeNull()
    expect(d.feed({ type: "text", part: { text: "hi" } })).toBeNull()
  })

  test("입력이 달라도 같은 오류가 반복되면 알린다", () => {
    const d = new LoopDetector(3)
    const err = (n: number) => tool("bash", { command: `cmd${n}` }, "error", { error: "command not found" })
    expect(d.feed(err(1))).toBeNull()
    expect(d.feed(err(2))).toBeNull()
    expect(d.feed(err(3))).toContain("같은 오류")
  })
})

describe("스냅샷", () => {
  test("추가/수정/삭제를 구분하고 무시 폴더는 건너뛴다", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-snap-"))
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(root, "src/a.py"), "a")
    writeFileSync(join(root, "src/b.py"), "b")
    writeFileSync(join(root, "node_modules/x.js"), "x")
    const before = takeSnapshot(root)
    expect(Object.keys(before).sort()).toEqual(["src/a.py", "src/b.py"])
    writeFileSync(join(root, "src/a.py"), "a2")
    rmSync(join(root, "src/b.py"))
    writeFileSync(join(root, "src/c.py"), "c")
    expect(diffSnapshots(before, takeSnapshot(root))).toEqual({ added: ["src/c.py"], modified: ["src/a.py"], removed: ["src/b.py"] })
  })
})

const result = (over: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0, endedBy: "exit", events: [{ type: "text" }], text: "완료", durationMs: 10, firstEventMs: 1, firstTextMs: 1,
  toolCalls: 0, steps: 1, inputTokens: 0, outputTokens: 0, stderrTail: "", sessionID: "ses_1", ...over,
})
const outcome = (over: Partial<AttemptOutcome> = {}, r: Partial<RunResult> = {}): AttemptOutcome => ({
  result: result(r), abortedBy: null, maxPromptTokens: 1000, tail: "", ...over,
})

describe("실패 판정", () => {
  test("정상 종료는 성공", () => expect(failureReason(outcome())).toBeNull())
  test("중단 사유를 구분한다", () => {
    expect(failureReason(outcome({ abortedBy: "stall", abortDetail: "응답이 120초간 멈춤" }))).toBe("응답이 120초간 멈춤")
    expect(failureReason(outcome({ abortedBy: "loop" }))).toBe("같은 동작이 반복됨")
    expect(failureReason(outcome({ abortedBy: "budget" }))).toBe("시간 예산을 넘김")
    expect(failureReason(outcome({}, { endedBy: "timeout" }))).toContain("시간 제한")
    expect(failureReason(outcome({}, { exitCode: 2, stderrTail: "x\nboom" }))).toBe("비정상 종료(코드 2): boom")
    expect(failureReason(outcome({}, { events: [], text: "" }))).toBe("응답이 비어 있음")
  })
})

describe("프롬프트", () => {
  test("이어하기·요약 프롬프트에 필요한 정보가 들어간다", () => {
    expect(continuePrompt("응답이 멈춤")).toContain("응답이 멈춤")
    const s = summaryPrompt({ goal: "로그인 수정", reason: "루프", changed: ["a.py", "b.py"], tail: "bash: pytest 실패" })
    expect(s).toContain("로그인 수정")
    expect(s).toContain("- a.py")
    expect(s).toContain("bash: pytest 실패")
    expect(summaryPrompt({ goal: "g", reason: "r", changed: [], tail: "" })).toContain("아직 변경된 파일 없음")
  })
})

describe("감독자", () => {
  const policy = (over: Partial<DayConfig> = {}): DayConfig => ({ ...DAY_DEFAULTS, maxAttempts: 4, ...over })
  const run = (script: Array<(spec: AttemptSpec) => AttemptOutcome>, over: Partial<DayConfig> = {}, root = mkdtempSync(join(tmpdir(), "ocx-sv-"))) => {
    const specs: AttemptSpec[] = []
    const notices: string[] = []
    let i = 0
    const p = supervise({
      goal: "로그인 수정",
      policy: policy(over),
      contextLimit: 10000,
      takeSnapshot: () => takeSnapshot(root),
      notify: (m) => notices.push(m),
      stateFile: join(root, ".batch/day-state.json"),
      runAttempt: async (spec) => {
        specs.push(spec)
        return script[Math.min(i++, script.length - 1)]!(spec)
      },
    })
    return { p, specs, notices, root }
  }

  test("처음에 성공하면 한 번만 실행한다", async () => {
    const { p, specs } = run([() => outcome()])
    const r = await p
    expect(r.status).toBe("done")
    expect(specs.length).toBe(1)
    expect(specs[0]!.kind).toBe("fresh")
    expect(specs[0]!.prompt).toBe("로그인 수정")
    expect(specs[0]!.light).toBe(false)
  })

  test("정체되면 같은 세션으로 이어서 하고, 성공하면 끝낸다", async () => {
    const { p, specs, notices } = run([() => outcome({ abortedBy: "stall", abortDetail: "응답이 멈춤" }), () => outcome()])
    const r = await p
    expect(r.status).toBe("done")
    expect(specs[1]).toMatchObject({ kind: "continue", sessionID: "ses_1", light: true })
    expect(specs[1]!.prompt).toContain("응답이 멈춤")
    expect(notices.join("\n")).toContain("같은 세션으로 이어서")
  })

  test("이어하기도 실패하면 새 세션 + 변경 파일 요약으로 넘어간다", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-sv-"))
    const { p, specs } = run(
      [
        () => (writeFileSync(join(root, "a.py"), "수정됨"), outcome({ abortedBy: "stall", tail: "마지막: pytest" })),
        () => outcome({ abortedBy: "budget" }),
        () => outcome(),
      ],
      {},
      root,
    )
    const r = await p
    expect(r.status).toBe("done")
    expect(specs.map((s) => s.kind)).toEqual(["fresh", "continue", "fresh"])
    expect(specs[2]!.prompt).toContain("- a.py")
    expect(r.changedFiles).toEqual(["a.py"])
    expect(r.attempts.length).toBe(3)
  })

  test("루프가 감지되면 바로 새 세션으로 간다", async () => {
    const { p, specs } = run([() => outcome({ abortedBy: "loop", abortDetail: "같은 도구 호출(read)이 3번 연속 반복됨" }), () => outcome()])
    await p
    expect(specs[1]!.kind).toBe("fresh")
    expect(specs[1]!.prompt).toContain("같은 도구 호출(read)")
  })

  test("컨텍스트 사용량이 높으면 이어하기 대신 새 세션으로 간다", async () => {
    const { p, specs, notices } = run([() => outcome({ abortedBy: "stall", maxPromptTokens: 8000 }), () => outcome()])
    await p
    expect(specs[1]!.kind).toBe("fresh")
    expect(notices.join("\n")).toContain("컨텍스트 사용량이 80%")
  })

  test("최대 시도 횟수에 도달하면 보류한다", async () => {
    const { p, specs, notices } = run([() => outcome({ abortedBy: "stall" })], { maxAttempts: 3 })
    const r = await p
    expect(r.status).toBe("held")
    expect(specs.length).toBe(3)
    expect(notices.join("\n")).toContain("보류")
  })

  test("진행 상태를 파일에 저장한다", async () => {
    const { p, root } = run([() => outcome({ abortedBy: "stall" }), () => outcome()])
    await p
    const saved = JSON.parse(readFileSync(join(root, ".batch/day-state.json"), "utf8"))
    expect(saved.status).toBe("done")
    expect(saved.attempts.length).toBe(2)
    expect(saved.goal).toBe("로그인 수정")
  })

  test("재개: 이전 세션을 이어서 시작하고 이전 시도 기록을 유지한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-sv-"))
    const specs: AttemptSpec[] = []
    const prior = [{ n: 1, kind: "fresh" as const, light: false, endedBy: "stall", reason: "응답이 멈춤", durationMs: 5, promptTokens: null, changedFiles: [], sessionID: "ses_old" }]
    const r = await supervise({
      goal: "목표",
      policy: policy(),
      contextLimit: 10000,
      takeSnapshot: () => takeSnapshot(root),
      priorAttempts: prior,
      initial: { n: 2, kind: "continue", sessionID: "ses_old", prompt: continuePrompt("재개"), light: true },
      runAttempt: async (spec) => (specs.push(spec), outcome()),
    })
    expect(specs[0]).toMatchObject({ n: 2, kind: "continue", sessionID: "ses_old" })
    expect(r.attempts.map((a) => a.n)).toEqual([1, 2])
  })
})
