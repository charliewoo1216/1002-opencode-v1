import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_ANALYZE, AGENT_PLAN } from "../src/agents"
import type { AgentCall, AgentRunner } from "../src/exec"
import { createLogger } from "../src/logger"
import { layoutFor } from "../src/paths"
import { checkApproval, intentPath, tasksPath } from "../src/plan"
import { loadProfile } from "../src/profile"
import { cleanMarkdown, runPlanFlow, type PlanFlowOptions } from "../src/planflow"
import type { RunResult } from "../src/runner"
import { fakeConfig } from "./helpers"

const intentDoc = (open: string) => `# 의도·시나리오 계획서
## 목적
로그인 개선
## 범위
- 검증 추가
## 비목표
- UI 변경
## 전체 완료 기준
- 테스트 통과
## 열린 질문
${open}
`
const tasksDoc = (dep = "없음") => `# 코드 작업 계획서
## 작업 T1: 검증 추가
- 유형: 구현
- 설명: 검증 함수를 추가한다
- 대상 파일: \`src/a.py\`
- 의존: ${dep}
- 검증 명령: \`python -m pytest\`
- 완료 기준:
  - 테스트가 통과한다
`
const ok = (text: string): RunResult => ({
  exitCode: 0, endedBy: "exit", events: [], text, durationMs: 1, firstEventMs: 1, firstTextMs: 1,
  toolCalls: 0, steps: 1, inputTokens: 0, outputTokens: 0, stderrTail: "",
})
const bad = (endedBy: RunResult["endedBy"]): RunResult => ({ ...ok(""), endedBy, exitCode: null })

function setup(script: (call: AgentCall, n: number) => RunResult, extra: Partial<PlanFlowOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-pf-"))
  const layout = layoutFor(root)
  const calls: AgentCall[] = []
  const runAgent: AgentRunner = async (call) => {
    calls.push(call)
    return script(call, calls.length)
  }
  const opts: PlanFlowOptions = {
    cfg: fakeConfig(),
    layout,
    model: "a",
    profile: loadProfile("python"),
    instruction: "로그인 검증을 개선해 줘",
    runAgent,
    ask: async () => null,
    confirm: async () => true,
    log: createLogger("error"),
    ...extra,
  }
  return { root, layout, calls, opts }
}

const label = (c: AgentCall) => c.label ?? ""

describe("문서 정리", () => {
  test("코드 펜스와 앞쪽 잡담을 제거한다", () => {
    expect(cleanMarkdown("```markdown\n# 제목\n내용\n```")).toBe("# 제목\n내용\n")
    expect(cleanMarkdown("네, 작성했습니다.\n\n# 제목\n내용")).toBe("# 제목\n내용\n")
    expect(cleanMarkdown("# 제목")).toBe("# 제목\n")
  })
})

describe("계획 모드 흐름", () => {
  test("질문 없이 끝까지 진행해 승인한다", async () => {
    const { layout, calls, opts } = setup((c) => ok(label(c) === "plan:intent" ? intentDoc("없음") : tasksDoc()), { autoApprove: true })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("approved")
    expect(r.approved).toBe(true)
    expect(calls.map(label)).toEqual(["plan:intent", "plan:tasks"])
    expect(calls.every((c) => c.agent === AGENT_PLAN)).toBe(true)
    expect(calls[0]!.prompt).toContain("로그인 검증을 개선해 줘")
    expect(calls[0]!.prompt).toContain("python")
    expect(checkApproval(layout).approved).toBe(true)
    expect(existsSync(intentPath(layout))).toBe(true)
  })

  test("열린 질문은 사용자에게 묻고 답을 반영한다", async () => {
    const asked: string[] = []
    const { calls, opts } = setup(
      (c) => {
        if (label(c) === "plan:intent") return ok(intentDoc("- 인증 방식은 무엇인가?"))
        if (label(c) === "plan:intent-revise") return ok(intentDoc("없음"))
        return ok(tasksDoc())
      },
      { ask: async (q) => (asked.push(q), "세션 쿠키 방식"), confirm: async () => true },
    )
    const r = await runPlanFlow(opts)
    expect(asked).toEqual(["인증 방식은 무엇인가?"])
    expect(r.stage).toBe("approved")
    const revise = calls.find((c) => label(c) === "plan:intent-revise")!
    expect(revise.prompt).toContain("세션 쿠키 방식")
    expect(revise.prompt).toContain("새로 만들어 넣지 마세요")
  })

  test("비대화형이면 질문이 남은 채 멈추고 작업 계획서는 만들지 않는다", async () => {
    const { layout, calls, opts } = setup(() => ok(intentDoc("- 인증 방식은?")), { ask: async () => null })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("intent")
    expect(r.openQuestions).toEqual(["인증 방식은?"])
    expect(calls.length).toBe(1)
    expect(existsSync(tasksPath(layout))).toBe(false)
    expect(r.approved).toBe(false)
  })

  test("작업 계획서 오류는 문제를 알려 주며 다시 쓰게 한다", async () => {
    let tasksCalls = 0
    const { calls, opts } = setup((c) => {
      if (label(c) === "plan:intent") return ok(intentDoc("없음"))
      tasksCalls++
      return ok(tasksCalls === 1 ? tasksDoc("T9") : tasksDoc())
    })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("approved")
    const second = calls.filter((c) => label(c) === "plan:tasks")[1]!
    expect(second.prompt).toContain("존재하지 않는 작업에 의존합니다 (T9)")
  })

  test("계속 오류면 승인하지 않고 파일은 남긴다", async () => {
    const { layout, opts } = setup((c) => ok(label(c) === "plan:intent" ? intentDoc("없음") : tasksDoc("T9")), { maxRepairs: 1 })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("tasks")
    expect(r.validation?.ok).toBe(false)
    expect(r.message).toContain("ocx plan --approve")
    expect(existsSync(tasksPath(layout))).toBe(true)
    expect(checkApproval(layout).approved).toBe(false)
  })

  test("사용자가 승인하지 않으면 승인 기록을 만들지 않는다", async () => {
    const { layout, opts } = setup((c) => ok(label(c) === "plan:intent" ? intentDoc("없음") : tasksDoc()), { confirm: async () => false })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("tasks")
    expect(r.approved).toBe(false)
    expect(checkApproval(layout).approved).toBe(false)
  })

  test("에이전트 실행이 실패하면 실패로 끝낸다", async () => {
    const { opts } = setup(() => bad("stall"))
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("failed")
    expect(r.message).toContain("stall")
  })

  test("의도 계획서 필수 항목이 계속 빠지면 실패 처리", async () => {
    const { layout, opts } = setup(() => ok("# 의도\n## 목적\n짧음\n"), { maxRepairs: 1 })
    const r = await runPlanFlow(opts)
    expect(r.stage).toBe("failed")
    expect(r.message).toContain("필수 항목")
    expect(existsSync(intentPath(layout))).toBe(true)
  })

  test("참조 자료가 있으면 먼저 분석하고 계획서에 요약을 넣는다", async () => {
    const note = (id: string) => `# ${id}\n## 개요\n가\n## 구성 요소\n- \`reference/app/main.py\`\n## 핵심 흐름\n나\n## 외부 의존\n없음\n## 주의점\n없음\n## 요약\n앱 진입점 모듈입니다.\n`
    const { calls, opts } = setup((c) => {
      if (c.agent === AGENT_ANALYZE) return ok(note("app"))
      return ok(label(c) === "plan:intent" ? intentDoc("없음") : tasksDoc())
    }, { autoApprove: true })
    mkdirSync(join(opts.layout.root, "reference/app"), { recursive: true })
    writeFileSync(join(opts.layout.root, "reference/app/main.py"), "print('hi')")
    const r = await runPlanFlow(opts)
    expect(r.analysis?.analyzed).toEqual(["app"])
    expect(calls[0]!.agent).toBe(AGENT_ANALYZE)
    const intentCall = calls.find((c) => label(c) === "plan:intent")!
    expect(intentCall.prompt).toContain("앱 진입점 모듈입니다.")
    expect(r.stage).toBe("approved")
  })
})
