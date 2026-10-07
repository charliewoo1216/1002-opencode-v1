import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layoutFor } from "../src/paths"
import {
  INTENT_TEMPLATE, TASKS_TEMPLATE, approvePlan, checkApproval, checkIntent, intentPath, orderTasks,
  parseTaskPlan, tasksPath, validateTaskPlan,
} from "../src/plan"

const goodTasks = `# 코드 작업 계획서

## 작업 T1: 검증 함수 추가
- 유형: 구현
- 설명: 이메일과 비밀번호 검증 함수를 추가한다.
  두 번째 줄도 설명이다.
- 대상 파일: \`src/auth/validate.py\`, \`tests/test_validate.py\`
- 의존: 없음
- 검증 명령: \`python -m pytest tests/test_validate.py\`, \`python -m ruff check .\`
- 완료 기준:
  - [ ] 잘못된 이메일을 거부한다
  - 빈 비밀번호를 거부한다

## 작업 T2: 핸들러에 적용
- 유형: 구현
- 설명: 로그인 핸들러에 적용
- 대상 파일: \`src/auth/handler.py\`
- 의존: T1
- 검증 명령: \`python -m pytest\`
- 완료 기준:
  - 로그인 테스트가 통과한다
`

const goodIntent = `# 의도·시나리오 계획서
## 목적
로그인 개선
## 범위
- 검증 추가
## 비목표
- UI 변경
## 전체 완료 기준
- 모든 테스트 통과
## 열린 질문
없음
`

describe("작업 계획서 파서", () => {
  test("정상 계획서를 읽는다", () => {
    const { tasks, problems } = parseTaskPlan(goodTasks)
    expect(problems).toEqual([])
    expect(tasks.map((t) => t.id)).toEqual(["T1", "T2"])
    const t1 = tasks[0]!
    expect(t1.title).toBe("검증 함수 추가")
    expect(t1.type).toBe("구현")
    expect(t1.description).toBe("이메일과 비밀번호 검증 함수를 추가한다. 두 번째 줄도 설명이다.")
    expect(t1.files).toEqual(["src/auth/validate.py", "tests/test_validate.py"])
    expect(t1.dependsOn).toEqual([])
    expect(t1.verify).toEqual(["python -m pytest tests/test_validate.py", "python -m ruff check ."])
    expect(t1.criteria).toEqual(["잘못된 이메일을 거부한다", "빈 비밀번호를 거부한다"])
    expect(tasks[1]!.dependsOn).toEqual(["T1"])
  })

  test("형식이 틀린 작업 제목을 알려 준다", () => {
    const { problems } = parseTaskPlan("## 작업 제목만 있음\n- 유형: 구현\n")
    expect(problems[0]).toContain("작업 제목 형식")
  })

  test("전각 콜론과 띄어쓴 필드 이름도 읽는다", () => {
    const { tasks } = parseTaskPlan("## 작업 A1： 제목\n- 유형： 분석\n- 설명: 설명\n- 대상 파일: a.py, b.py\n- 검증 명령: 없음\n- 완료 기준: 모두 다룬다\n")
    expect(tasks[0]!.type).toBe("분석")
    expect(tasks[0]!.files).toEqual(["a.py", "b.py"])
    expect(tasks[0]!.verify).toEqual([])
    expect(tasks[0]!.criteria).toEqual(["모두 다룬다"])
  })

  test("템플릿 자체도 파싱된다", () => {
    const { tasks } = parseTaskPlan(TASKS_TEMPLATE)
    expect(tasks.length).toBe(2)
  })
})

describe("작업 계획서 검증", () => {
  test("정상 계획서는 통과", () => {
    const v = validateTaskPlan(parseTaskPlan(goodTasks))
    expect(v.ok).toBe(true)
    expect(v.reviewNeeded).toEqual([])
  })

  test("오류를 모두 찾아낸다", () => {
    const md = `## 작업 T1: a
- 유형: 이상한유형
- 설명:
- 대상 파일: \`/etc/passwd\`, \`../x\`
- 의존: T9, T1

## 작업 T1: 중복
- 유형: 구현
- 설명: 중복 번호
`
    const v = validateTaskPlan(parseTaskPlan(md))
    const text = v.errors.join("\n")
    expect(v.ok).toBe(false)
    expect(text).toContain("중복")
    expect(text).toContain("유형은")
    expect(text).toContain("설명이 없습니다")
    expect(text).toContain("상대 경로")
    expect(text).toContain("존재하지 않는 작업에 의존")
    expect(text).toContain("자기 자신")
  })

  test("순환 의존을 찾는다", () => {
    const md = `## 작업 A: a\n- 유형: 분석\n- 설명: x\n- 의존: B\n- 완료 기준: y\n## 작업 B: b\n- 유형: 분석\n- 설명: x\n- 의존: A\n- 완료 기준: y\n`
    const v = validateTaskPlan(parseTaskPlan(md))
    expect(v.errors.join("\n")).toContain("순환")
    expect(() => orderTasks(parseTaskPlan(md).tasks)).toThrow("순환")
  })

  test("완료 기준·검증 명령이 없으면 검토 필요로 표시", () => {
    const md = `## 작업 T1: a\n- 유형: 구현\n- 설명: x\n- 대상 파일: \`a.py\`\n`
    const v = validateTaskPlan(parseTaskPlan(md))
    expect(v.ok).toBe(true)
    expect(v.reviewNeeded.map((r) => r.reason)).toEqual(["완료 기준이 없습니다", "검증 명령이 없어 자동으로 완료를 판정할 수 없습니다"])
  })

  test("의존 순서대로 정렬하되 작성 순서를 유지한다", () => {
    const md = `## 작업 C: c\n- 유형: 분석\n- 설명: x\n- 의존: A\n- 완료 기준: y\n## 작업 A: a\n- 유형: 분석\n- 설명: x\n- 완료 기준: y\n## 작업 B: b\n- 유형: 분석\n- 설명: x\n- 완료 기준: y\n`
    expect(orderTasks(parseTaskPlan(md).tasks).map((t) => t.id)).toEqual(["A", "C", "B"])
  })
})

describe("의도 계획서 검사", () => {
  test("필수 항목과 열린 질문", () => {
    expect(checkIntent(goodIntent)).toEqual({ missingHeadings: [], openQuestions: [] })
    const c = checkIntent("# x\n## 목적\n가\n## 열린 질문\n- 인증 방식은 무엇인가?\n- 기한은?\n")
    expect(c.missingHeadings).toEqual(["범위", "비목표", "전체 완료 기준"])
    expect(c.openQuestions).toEqual(["인증 방식은 무엇인가?", "기한은?"])
  })

  test("템플릿의 자리표시 문구는 질문으로 세지 않는다", () => {
    expect(checkIntent(INTENT_TEMPLATE).openQuestions).toEqual([])
  })
})

describe("승인", () => {
  const setup = (intent = goodIntent, tasks = goodTasks) => {
    const layout = layoutFor(mkdtempSync(join(tmpdir(), "ocx-ap-")))
    mkdirSync(layout.plan, { recursive: true })
    writeFileSync(intentPath(layout), intent)
    writeFileSync(tasksPath(layout), tasks)
    return layout
  }

  test("승인 기록이 없으면 승인되지 않은 상태", () => {
    expect(checkApproval(setup()).approved).toBe(false)
  })

  test("검사를 통과하면 승인되고, 문서를 바꾸면 무효가 된다", () => {
    const layout = setup()
    expect(approvePlan(layout).ok).toBe(true)
    expect(checkApproval(layout)).toEqual({ approved: true })
    writeFileSync(tasksPath(layout), goodTasks + "\n## 작업 T3: 추가\n- 유형: 분석\n- 설명: x\n- 완료 기준: y\n")
    const s = checkApproval(layout)
    expect(s.approved).toBe(false)
    expect(s.reason).toContain("작업 계획서가 변경")
  })

  test("열린 질문이 남았거나 계획서에 오류가 있으면 승인하지 않는다", () => {
    const q = setup(goodIntent.replace("없음", "- 방식은?"))
    const r1 = approvePlan(q)
    expect(r1.ok).toBe(false)
    expect(r1.reasons.join("\n")).toContain("열린 질문")
    expect(checkApproval(q).approved).toBe(false)

    const bad = setup(goodIntent, "## 작업 T1: a\n- 유형: 구현\n")
    expect(approvePlan(bad).ok).toBe(false)
  })

  test("계획서 파일이 없으면 승인할 수 없다", () => {
    const layout = layoutFor(mkdtempSync(join(tmpdir(), "ocx-ap-")))
    const r = approvePlan(layout)
    expect(r.ok).toBe(false)
    expect(r.reasons.length).toBe(2)
  })
})
