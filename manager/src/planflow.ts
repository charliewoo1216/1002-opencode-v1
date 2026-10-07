// 계획 모드 흐름
// 참조 분석 -> 의도·시나리오 계획서 -> (열린 질문이 있으면 사용자에게 질문) -> 코드 작업 계획서 -> 검증 -> 승인
// 원본의 질문 도구는 비대화형(run)에서 쓸 수 없으므로(단계 0 실측), 질문은 ocx가 터미널에서 직접 한다.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_ANALYZE, AGENT_PLAN } from "./agents"
import { analyzeReference, notesOverview, scanSourceFiles, type AnalyzeReport } from "./analyze"
import type { OcxConfig } from "./config"
import type { Logger } from "./logger"
import type { Layout } from "./paths"
import {
  INTENT_TEMPLATE, TASKS_TEMPLATE, approvePlan, checkIntent, intentPath, parseTaskPlan, tasksPath, validateTaskPlan,
  type PlanValidation,
} from "./plan"
import type { Profile } from "./profile"
import type { AgentRunner } from "./exec"

/** 모델 응답에서 문서 본문만 꺼낸다: 코드 펜스와 앞쪽 잡담을 제거 */
export function cleanMarkdown(text: string): string {
  let t = text.trim()
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fence) t = fence[1]!.trim()
  const first = t.search(/^#\s/m)
  if (first > 0) t = t.slice(first)
  return t.trim() + "\n"
}

export interface PlanFlowOptions {
  cfg: OcxConfig
  layout: Layout
  model: string
  profile: Profile
  /** 사용자가 적은 몇 줄의 지시 */
  instruction: string
  runAgent: AgentRunner
  /** 사용자에게 질문하고 답을 받는다. 비대화형이면 null을 돌려준다 */
  ask: (question: string) => Promise<string | null>
  /** 승인 여부 확인. 비대화형이면 false */
  confirm: (message: string) => Promise<boolean>
  log: Logger
  /** 참조 분석 건너뛰기 */
  skipAnalysis?: boolean
  /** 확인 없이 승인 (명시적으로 요청한 경우만) */
  autoApprove?: boolean
  maxInterviewRounds?: number
  /** 형식 오류 시 다시 쓰게 하는 횟수 */
  maxRepairs?: number
}

export interface PlanFlowResult {
  stage: "intent" | "tasks" | "approved" | "failed"
  message: string
  analysis?: AnalyzeReport
  openQuestions: string[]
  validation?: PlanValidation
  approved: boolean
}

function writeDoc(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function profileBlock(p: Profile): string {
  const verify = Object.entries(p.verify)
    .map(([k, v]) => `  - ${k}: \`${v}\``)
    .join("\n")
  return `프로필: ${p.name} (${p.description})
기본 검증 명령(프로젝트에 맞게 바꿔서 쓰세요):
${verify || "  (없음)"}
${p.planningRules ? `계획서 작성 규칙:\n${p.planningRules.trim()}` : ""}`
}

export function intentPrompt(o: { instruction: string; profile: Profile; overview: string }): string {
  return `사용자 지시:
${o.instruction.trim()}

${profileBlock(o.profile)}

참조 분석 요약:
${o.overview}

위 내용을 바탕으로 '의도·시나리오 계획서'를 작성하세요. 사용자의 지시를 넓히거나 바꾸지 말고, 하지 않을 일은 비목표에 적으세요.
모호한 점은 추측하지 말고 "열린 질문"에 질문 형태로 적으세요. 없으면 "없음"이라고 적으세요.
아래 템플릿의 제목과 순서를 그대로 지켜 작성하세요.

${INTENT_TEMPLATE}`
}

export function tasksPrompt(o: { intent: string; profile: Profile; overview: string; feedback?: string }): string {
  return `아래는 승인 대기 중인 의도·시나리오 계획서입니다.

${o.intent.trim()}

${profileBlock(o.profile)}

참조 분석 요약:
${o.overview}

위 의도를 벗어나지 않는 '코드 작업 계획서'를 작성하세요.
- 작업은 작게 나누고, 한 작업은 한 가지 일만 합니다.
- 구현·MCP 작업에는 반드시 실행 가능한 검증 명령(빌드/테스트)을 적으세요.
- 모든 작업에 확인 가능한 완료 기준을 적으세요.
- 대상 파일은 작업 폴더 기준 상대 경로로 적으세요.
- 계획서에 없는 범위(비목표)는 작업으로 만들지 마세요.
아래 템플릿의 형식을 정확히 지켜 작성하세요.
${o.feedback ? `\n이전 작성본의 문제점입니다. 모두 고쳐서 전체 문서를 다시 작성하세요:\n${o.feedback}\n` : ""}
${TASKS_TEMPLATE}`
}

export async function runPlanFlow(o: PlanFlowOptions): Promise<PlanFlowResult> {
  const { layout, log } = o
  const maxRepairs = o.maxRepairs ?? 2
  const result: PlanFlowResult = { stage: "intent", message: "", openQuestions: [], approved: false }

  // 1) 참조 분석
  const refRoot = join(layout.root, o.cfg.referenceDir)
  if (!o.skipAnalysis && existsSync(refRoot) && scanSourceFiles(refRoot).length > 0) {
    log.info(`참조 자료 분석 시작: ${o.cfg.referenceDir}/`)
    result.analysis = await analyzeReference({
      cfg: o.cfg,
      layout,
      referenceRoot: refRoot,
      model: o.model,
      log,
      runUnit: (u, prompt) => o.runAgent({ agent: AGENT_ANALYZE, prompt, label: `analyze:${u.id}` }),
    })
    if (result.analysis.failed.length > 0) {
      log.warn(`분석에 실패한 단위가 있습니다: ${result.analysis.failed.map((f) => f.id).join(", ")} (계획서에는 분석된 부분만 반영됩니다)`)
    }
  }
  const overview = notesOverview(layout)

  // 2) 의도·시나리오 계획서
  let intent = ""
  let prompt = intentPrompt({ instruction: o.instruction, profile: o.profile, overview })
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await o.runAgent({ agent: AGENT_PLAN, prompt, label: "plan:intent" })
    if (res.endedBy !== "exit" || res.exitCode !== 0 || !res.text.trim()) {
      result.stage = "failed"
      result.message = `의도 계획서를 만들지 못했습니다 (${res.endedBy}, 종료코드 ${res.exitCode}).`
      return result
    }
    intent = cleanMarkdown(res.text)
    const c = checkIntent(intent)
    if (c.missingHeadings.length === 0) break
    if (attempt === maxRepairs) {
      writeDoc(intentPath(layout), intent)
      result.stage = "failed"
      result.message = `의도 계획서에 필수 항목이 없습니다: ${c.missingHeadings.join(", ")}. ${intentPath(layout)}을(를) 직접 고친 뒤 다시 실행하세요.`
      return result
    }
    prompt = intentPrompt({ instruction: o.instruction, profile: o.profile, overview }) +
      `\n\n이전 작성본에 다음 항목이 없었습니다: ${c.missingHeadings.join(", ")}. 템플릿의 모든 제목을 포함해 다시 작성하세요.`
  }

  // 3) 열린 질문 -> 사용자에게 질문 -> 반영
  const rounds = o.maxInterviewRounds ?? 3
  for (let round = 0; round < rounds; round++) {
    const open = checkIntent(intent).openQuestions
    if (open.length === 0) break
    const answers: Array<{ q: string; a: string }> = []
    for (const q of open) {
      const a = await o.ask(q)
      if (a === null) break // 비대화형: 질문하지 않음
      if (a.trim()) answers.push({ q, a: a.trim() })
    }
    if (answers.length === 0) break
    const revisePrompt = `현재 의도·시나리오 계획서입니다.

${intent.trim()}

사용자의 답변입니다.
${answers.map((x) => `- 질문: ${x.q}\n  답: ${x.a}`).join("\n")}

답변을 반영해서 열린 질문을 해소하고 전체 문서를 같은 형식으로 다시 작성하세요. 답이 없는 질문만 "열린 질문"에 남기세요. 사용자의 답변에 없는 내용을 새로 만들어 넣지 마세요.`
    const res = await o.runAgent({ agent: AGENT_PLAN, prompt: revisePrompt, label: "plan:intent-revise" })
    if (res.endedBy !== "exit" || res.exitCode !== 0 || !res.text.trim()) {
      result.stage = "failed"
      result.message = "답변을 반영한 의도 계획서를 만들지 못했습니다."
      return result
    }
    const revised = cleanMarkdown(res.text)
    if (checkIntent(revised).missingHeadings.length === 0) intent = revised
  }
  writeDoc(intentPath(layout), intent)
  const ic = checkIntent(intent)
  result.openQuestions = ic.openQuestions
  if (ic.openQuestions.length > 0) {
    result.stage = "intent"
    result.message = `의도 계획서에 답이 없는 질문이 ${ic.openQuestions.length}개 남아 있습니다. ${intentPath(layout)}을(를) 직접 고치거나 다시 실행해 답해 주세요. 질문이 해소되기 전에는 작업 계획서를 만들지 않습니다.`
    return result
  }

  // 4) 코드 작업 계획서 (형식 검증 + 다시 쓰기)
  let feedback: string | undefined
  let tasksMd = ""
  let validation: PlanValidation | undefined
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await o.runAgent({
      agent: AGENT_PLAN,
      prompt: tasksPrompt({ intent, profile: o.profile, overview, feedback }),
      label: "plan:tasks",
    })
    if (res.endedBy !== "exit" || res.exitCode !== 0 || !res.text.trim()) {
      result.stage = "failed"
      result.message = `작업 계획서를 만들지 못했습니다 (${res.endedBy}, 종료코드 ${res.exitCode}).`
      return result
    }
    tasksMd = cleanMarkdown(res.text)
    validation = validateTaskPlan(parseTaskPlan(tasksMd))
    if (validation.ok) break
    feedback = validation.errors.map((e) => `- ${e}`).join("\n")
    log.warn(`작업 계획서 형식 문제 (${attempt + 1}/${maxRepairs + 1}): ${validation.errors.length}건`)
  }
  writeDoc(tasksPath(layout), tasksMd)
  result.validation = validation
  if (!validation?.ok) {
    result.stage = "tasks"
    result.message = `작업 계획서에 오류가 남아 있습니다. ${tasksPath(layout)}을(를) 직접 고친 뒤 'ocx plan --approve'로 승인하세요.\n${validation?.errors.map((e) => `  - ${e}`).join("\n")}`
    return result
  }

  // 5) 승인
  const review = validation.reviewNeeded.map((r) => `${r.taskId}: ${r.reason}`)
  const summary = `작업 ${parseTaskPlan(tasksMd).tasks.length}개 생성${review.length ? `, 검토 필요 ${review.length}건 (${review.join("; ")})` : ""}`
  const approve = o.autoApprove || (await o.confirm(`${summary}\n계획서(${intentPath(layout)}, ${tasksPath(layout)})를 확인했고 승인하시겠습니까?`))
  if (!approve) {
    result.stage = "tasks"
    result.message = `${summary}. 계획서를 확인한 뒤 'ocx plan --approve'로 승인하세요.`
    return result
  }
  const ap = approvePlan(layout)
  if (!ap.ok) {
    result.stage = "tasks"
    result.message = `승인할 수 없습니다:\n${ap.reasons.map((r) => `  - ${r}`).join("\n")}`
    return result
  }
  result.stage = "approved"
  result.approved = true
  result.message = `${summary}. 승인되었습니다.`
  return result
}
