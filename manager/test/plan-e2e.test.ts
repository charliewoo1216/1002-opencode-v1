// 계획 모드 end-to-end: 실제 원본 opencode + 모의 LLM + `ocx plan`
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyAllNotes } from "../src/analyze"
import { main } from "../src/cli"
import { layoutFor } from "../src/paths"
import { checkApproval } from "../src/plan"
import { startMockLlm } from "./mock-llm"
import { OPENCODE_AVAILABLE, OPENCODE_CMD } from "./helpers"

const suite = OPENCODE_AVAILABLE ? describe : describe.skip

const mock = startMockLlm(0)
afterAll(() => mock.stop())

const intentDoc = `# 의도·시나리오 계획서
## 목적
로그인 검증 개선
## 범위
- 검증 함수 추가
## 비목표
- UI 변경
## 전체 완료 기준
- 테스트 통과
## 열린 질문
없음
`
const tasksDoc = `# 코드 작업 계획서
## 작업 T1: 검증 함수 추가
- 유형: 구현
- 설명: 검증 함수를 추가한다
- 대상 파일: \`src/validate.py\`
- 의존: 없음
- 검증 명령: \`python -m pytest\`
- 완료 기준:
  - 테스트가 통과한다
`
const noteDoc = `# app
## 개요
앱 진입점
## 구성 요소
- \`reference/app/main.py\`: 진입점
## 핵심 흐름
시작
## 외부 의존
없음
## 주의점
없음
## 요약
앱 진입점 모듈입니다.
`

suite("ocx plan (원본 opencode + 모의 LLM)", () => {
  test("참조 분석 -> 의도 계획서 -> 작업 계획서 -> 승인까지 동작하고 읽기 전용 에이전트가 적용된다", async () => {
    mock.control.rules = [
      { match: "분석해 노트를 작성하세요", text: noteDoc },
      { match: "'의도·시나리오 계획서'를 작성하세요", text: intentDoc },
      { match: "'코드 작업 계획서'를 작성하세요", text: tasksDoc },
    ]
    const work = mkdtempSync(join(tmpdir(), "ocx-e2e-"))
    mkdirSync(join(work, "reference/app"), { recursive: true })
    writeFileSync(join(work, "reference/app/main.py"), "print('hello')\n")
    const cfgFile = join(work, "ocx.config.json")
    writeFileSync(
      cfgFile,
      JSON.stringify({
        opencode: { command: OPENCODE_CMD },
        models: { big: { baseURL: `${mock.url}/v1`, model: "big-model" } },
        defaultModel: "big",
      }),
    )
    process.env.OPENCODE_TEST_HOME = mkdtempSync(join(tmpdir(), "ocx-e2e-home-"))
    const logs: string[] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m: string) => void logs.push(String(m))
    console.error = () => {}
    let code: number
    try {
      code = await main(["plan", "--config", cfgFile, "--dir", work, "--profile", "python", "--yes", "로그인 검증을 개선해 줘"])
    } finally {
      console.log = origLog
      console.error = origErr
    }
    expect(code).toBe(0)

    const layout = layoutFor(work)
    expect(checkApproval(layout).approved).toBe(true)
    expect(readFileSync(join(layout.plan, "intent.md"), "utf8")).toContain("로그인 검증 개선")
    expect(readFileSync(join(layout.plan, "tasks.md"), "utf8")).toContain("작업 T1")
    expect(existsSync(join(layout.notes, "app.md"))).toBe(true)
    expect(verifyAllNotes(layout, { workRoot: work, referenceDir: "reference" }).every((v) => v.ok)).toBe(true)

    // 전용 에이전트 프롬프트가 적용되고, 읽기 전용이라 수정·실행 도구가 요청에서 빠져 있다
    const planCalls = mock.logs.filter((l) => l.systemText.includes("소프트웨어 작업 계획 작성자"))
    const analyzeCalls = mock.logs.filter((l) => l.systemText.includes("코드 분석가"))
    expect(planCalls.length).toBeGreaterThanOrEqual(2)
    expect(analyzeCalls.length).toBeGreaterThanOrEqual(1)
    for (const c of [...planCalls, ...analyzeCalls]) {
      expect(c.toolNames).toContain("read")
      for (const forbidden of ["edit", "write", "bash", "webfetch", "websearch"]) expect(c.toolNames).not.toContain(forbidden)
    }
    // 프로필 지침(AGENTS.md 내용)이 주입된다
    expect(planCalls.some((c) => c.systemText.includes("Python 개발 지침"))).toBe(true)

    // 속도 기록이 남는다
    const metrics = readFileSync(layout.metricsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(metrics.some((m) => m.mode === "plan" && m.label === "plan:tasks")).toBe(true)
    expect(metrics.every((m) => m.llm?.requests >= 1)).toBe(true)
    expect(logs.join("\n")).toContain("승인되었습니다")
  }, 240000)
})
