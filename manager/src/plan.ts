// 계획서: 템플릿, 파서, 검증기, 승인 기록
// - 의도·시나리오 계획서 (.plan/intent.md): 무엇을, 왜, 범위, 비목표, 전체 완료 기준
// - 코드 작업 계획서 (.plan/tasks.md): 작업 목록(유형, 대상 파일, 의존, 검증 명령, 완료 기준)
// - 승인 기록 (.plan/approval.json): 두 문서의 해시를 저장해, 승인 후 문서가 바뀌면 승인을 무효로 본다
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Layout } from "./paths"

export const TASK_TYPES = ["구현", "분석", "MCP"] as const
export type TaskType = (typeof TASK_TYPES)[number]

export interface PlanTask {
  id: string
  title: string
  type: TaskType | string
  description: string
  files: string[]
  dependsOn: string[]
  verify: string[]
  criteria: string[]
}

export const intentPath = (l: Layout) => join(l.plan, "intent.md")
export const tasksPath = (l: Layout) => join(l.plan, "tasks.md")
export const approvalPath = (l: Layout) => join(l.plan, "approval.json")

// ---------- 템플릿 (모델에게 형식을 알려 줄 때 사용) ----------

export const INTENT_REQUIRED_HEADINGS = ["목적", "범위", "비목표", "전체 완료 기준"] as const

export const INTENT_TEMPLATE = `# 의도·시나리오 계획서

## 목적
(무엇을 왜 하는가를 사용자의 말에서 벗어나지 않게 한두 문단으로)

## 배경
(현재 상황과 이 작업이 필요한 이유)

## 범위
- (이번에 하는 일)

## 비목표
- (이번에 하지 않는 일. 범위를 넓히지 않기 위해 반드시 적는다)

## 참조 자료
- (사용할 참조 코드·문서와 어떻게 참고하는지)

## 전체 완료 기준
- (전체 작업이 끝났다고 판단할 수 있는 확인 가능한 기준)

## 열린 질문
- (모르거나 모호한 점을 질문으로. 없으면 "없음")
`

export const TASKS_TEMPLATE = `# 코드 작업 계획서

## 작업 T1: (작업 제목)
- 유형: 구현
- 설명: (무엇을 하는지 구체적으로)
- 대상 파일: \`경로/파일1\`, \`경로/파일2\`
- 의존: 없음
- 검증 명령: \`(빌드 또는 테스트 명령)\`
- 완료 기준:
  - (확인 가능한 기준 1)
  - (확인 가능한 기준 2)

## 작업 T2: (작업 제목)
- 유형: 구현
- 설명: ...
- 대상 파일: \`...\`
- 의존: T1
- 검증 명령: \`...\`
- 완료 기준:
  - ...

(유형은 구현, 분석, MCP 중 하나. 작업 번호는 T1, T2처럼 붙이고 의존에는 먼저 끝나야 하는 작업 번호를 쓴다.)
`

// ---------- 파서 ----------

const HEADING_RE = /^##\s*작업\s+([A-Za-z0-9_-]+)\s*[:：]\s*(.+?)\s*$/
const FIELD_RE = /^\s*[-*]\s*(유형|설명|대상\s*파일|의존|검증\s*명령|완료\s*기준)\s*[:：]\s*(.*)$/

const NONE = /^(없음|-|—|n\/a|해당\s*없음)$/i

function splitList(value: string): string[] {
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter(Boolean)
  if (ticks.length > 0) return ticks
  return value
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s && !NONE.test(s))
}

export interface ParsedPlan {
  tasks: PlanTask[]
  /** 형식상 읽을 수 없는 부분 (오류 목록) */
  problems: string[]
}

export function parseTaskPlan(md: string): ParsedPlan {
  const tasks: PlanTask[] = []
  const problems: string[] = []
  let cur: PlanTask | null = null
  let field: "설명" | "완료기준" | null = null

  for (const raw of md.split(/\r?\n/)) {
    const h = raw.match(HEADING_RE)
    if (h) {
      cur = { id: h[1]!, title: h[2]!, type: "", description: "", files: [], dependsOn: [], verify: [], criteria: [] }
      tasks.push(cur)
      field = null
      continue
    }
    if (/^##\s*작업(\s|$)/.test(raw) && !h) {
      problems.push(`작업 제목 형식이 올바르지 않습니다: "${raw.trim()}" (예: ## 작업 T1: 제목)`)
      cur = null
      field = null
      continue
    }
    if (!cur) continue
    if (/^#{1,2}\s/.test(raw)) {
      // 작업이 아닌 다른 제목이 나오면 현재 작업을 닫는다
      cur = null
      field = null
      continue
    }
    const f = raw.match(FIELD_RE)
    if (f) {
      const key = f[1]!.replace(/\s+/g, "")
      const value = f[2]!.trim()
      field = null
      if (key === "유형") cur.type = value.replace(/`/g, "").trim()
      else if (key === "설명") {
        cur.description = value
        field = "설명"
      } else if (key === "대상파일") cur.files = splitList(value)
      else if (key === "의존") cur.dependsOn = splitList(value).filter((s) => !NONE.test(s))
      else if (key === "검증명령") cur.verify = splitList(value)
      else if (key === "완료기준") {
        field = "완료기준"
        if (value && !NONE.test(value)) cur.criteria.push(value)
      }
      continue
    }
    // 하위 목록 줄 (완료 기준 항목) 또는 이어지는 설명
    const sub = raw.match(/^\s{2,}[-*]\s*(?:\[[ xX]\]\s*)?(.+)$/)
    if (sub && field === "완료기준") {
      cur.criteria.push(sub[1]!.trim())
    } else if (raw.trim() && field === "설명" && !/^\s*[-*]\s/.test(raw)) {
      cur.description += " " + raw.trim()
    }
  }
  return { tasks, problems }
}

// ---------- 검증기 ----------

export interface PlanValidation {
  errors: string[]
  /** 진행은 가능하지만 사람이 확인해야 하는 항목 (예: 완료 기준 없음) */
  reviewNeeded: Array<{ taskId: string; reason: string }>
  ok: boolean
}

export function validateTaskPlan(parsed: ParsedPlan): PlanValidation {
  const errors = [...parsed.problems]
  const reviewNeeded: PlanValidation["reviewNeeded"] = []
  const { tasks } = parsed
  if (tasks.length === 0) errors.push("작업이 하나도 없습니다. '## 작업 T1: 제목' 형식으로 작업을 작성해야 합니다.")

  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`작업 번호가 중복되었습니다: ${t.id}`)
    ids.add(t.id)
  }
  for (const t of tasks) {
    if (!(TASK_TYPES as readonly string[]).includes(t.type)) {
      errors.push(`작업 ${t.id}: 유형은 ${TASK_TYPES.join(", ")} 중 하나여야 합니다 (현재: "${t.type || "없음"}")`)
    }
    if (!t.description.trim()) errors.push(`작업 ${t.id}: 설명이 없습니다`)
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`작업 ${t.id}: 자기 자신에 의존할 수 없습니다`)
      else if (!ids.has(d)) errors.push(`작업 ${t.id}: 존재하지 않는 작업에 의존합니다 (${d})`)
    }
    for (const f of t.files) {
      if (isAbsolute(f) || f.split(/[\\/]/).includes("..")) {
        errors.push(`작업 ${t.id}: 대상 파일은 작업 폴더 안의 상대 경로여야 합니다 (${f})`)
      }
    }
    if (t.criteria.length === 0) reviewNeeded.push({ taskId: t.id, reason: "완료 기준이 없습니다" })
    if ((t.type === "구현" || t.type === "MCP") && t.verify.length === 0) {
      reviewNeeded.push({ taskId: t.id, reason: "검증 명령이 없어 자동으로 완료를 판정할 수 없습니다" })
    }
  }
  const cycle = findCycle(tasks)
  if (cycle) errors.push(`작업 의존에 순환이 있습니다: ${cycle.join(" -> ")}`)
  return { errors, reviewNeeded, ok: errors.length === 0 }
}

function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const t of tasks) {
    const c = visit(t.id)
    if (c) return c
  }
  return null
}

/** 의존 관계를 지키는 실행 순서 (같은 조건이면 작성 순서 유지). 순환이 있으면 예외 */
export function orderTasks(tasks: PlanTask[]): PlanTask[] {
  const done = new Set<string>()
  const remaining = [...tasks]
  const out: PlanTask[] = []
  while (remaining.length > 0) {
    const idx = remaining.findIndex((t) => t.dependsOn.every((d) => done.has(d)))
    if (idx < 0) throw new Error("작업 의존에 순환이 있어 순서를 정할 수 없습니다")
    const [t] = remaining.splice(idx, 1)
    out.push(t!)
    done.add(t!.id)
  }
  return out
}

export interface IntentCheck {
  missingHeadings: string[]
  openQuestions: string[]
}

/** 마크다운에서 `## 제목` 아래 내용을 다음 `## ` 제목 전까지 잘라 돌려준다 (없으면 null) */
export function sectionOf(md: string, heading: string): string | null {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}\\s*$`).test(l))
  if (start < 0) return null
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    body.push(l)
  }
  return body.join("\n")
}

/** 의도 계획서의 필수 제목과 남은 열린 질문을 확인한다 */
export function checkIntent(md: string): IntentCheck {
  const missingHeadings = INTENT_REQUIRED_HEADINGS.filter((h) => sectionOf(md, h) === null)
  const openQuestions = (sectionOf(md, "열린 질문") ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter((l) => l && !NONE.test(l) && !/^\(.*\)$/.test(l))
  return { missingHeadings: [...missingHeadings], openQuestions }
}

// ---------- 승인 기록 ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

function readIf(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null
}

export interface Approval {
  version: 1
  approvedAt: string
  intentHash: string
  tasksHash: string
}

export interface ApprovalStatus {
  approved: boolean
  reason?: string
}

export function checkApproval(layout: Layout): ApprovalStatus {
  const raw = readIf(approvalPath(layout))
  if (raw === null) return { approved: false, reason: "승인 기록이 없습니다. 계획서를 확인하고 승인해야 합니다." }
  let a: Approval
  try {
    a = JSON.parse(raw)
  } catch {
    return { approved: false, reason: "승인 기록 파일이 손상되었습니다." }
  }
  const intent = readIf(intentPath(layout))
  const tasks = readIf(tasksPath(layout))
  if (intent === null || tasks === null) return { approved: false, reason: "계획서 파일이 없습니다." }
  if (sha(intent) !== a.intentHash) return { approved: false, reason: "승인 후 의도 계획서가 변경되었습니다. 다시 승인해야 합니다." }
  if (sha(tasks) !== a.tasksHash) return { approved: false, reason: "승인 후 작업 계획서가 변경되었습니다. 다시 승인해야 합니다." }
  return { approved: true }
}

export interface ApproveResult {
  ok: boolean
  reasons: string[]
}

/** 계획서를 검사한 뒤 승인 기록을 남긴다. 검사를 통과하지 못하면 승인하지 않는다 */
export function approvePlan(layout: Layout, now = new Date()): ApproveResult {
  const reasons: string[] = []
  const intent = readIf(intentPath(layout))
  const tasks = readIf(tasksPath(layout))
  if (intent === null) reasons.push("의도 계획서(.plan/intent.md)가 없습니다.")
  if (tasks === null) reasons.push("작업 계획서(.plan/tasks.md)가 없습니다.")
  if (intent === null || tasks === null) return { ok: false, reasons }

  const ic = checkIntent(intent)
  if (ic.missingHeadings.length) reasons.push(`의도 계획서에 필수 항목이 없습니다: ${ic.missingHeadings.join(", ")}`)
  if (ic.openQuestions.length) reasons.push(`의도 계획서에 답이 없는 열린 질문이 ${ic.openQuestions.length}개 남아 있습니다.`)
  const v = validateTaskPlan(parseTaskPlan(tasks))
  reasons.push(...v.errors)
  if (reasons.length) return { ok: false, reasons }

  mkdirSync(layout.plan, { recursive: true })
  const a: Approval = { version: 1, approvedAt: now.toISOString(), intentHash: sha(intent), tasksHash: sha(tasks) }
  writeFileSync(approvalPath(layout), JSON.stringify(a, null, 2))
  return { ok: true, reasons: [] }
}
