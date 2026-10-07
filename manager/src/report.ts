// 아침 리포트: 밤새 무엇이 되었고 무엇이 안 되었는지, 사람이 확인할 곳은 어디인지 정리한다
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { percentile, type RunMetric } from "./metrics"
import type { NightState, TaskState } from "./nightstate"
import type { Layout } from "./paths"

export const reportPath = (l: Layout) => join(l.batch, "report.md")

const dur = (ms: number) => {
  if (ms < 1000) return "0초"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${s % 60}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("ko-KR", { hour12: false }) : "-")

const END_REASON: Record<string, string> = {
  "all-done": "모든 작업 완료",
  deadline: "종료 시각 도달",
  "all-held": "남은 작업이 모두 보류·건너뜀",
  aborted: "사용자 중단",
}

const STATUS_LABEL: Record<string, string> = { pending: "대기(미실행)", running: "실행 중", done: "완료", held: "보류", skipped: "건너뜀" }
const VERIFY_LABEL: Record<string, string> = { passed: "통과", failed: "실패", none: "없음(미검증)" }
const CHECK_LABEL: Record<string, string> = { pass: "통과", fail: "미흡", unclear: "불명확", off: "-" }

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")

export interface ReportOptions {
  metrics?: RunMetric[]
  now?: Date
  /** 사람이 읽기 쉬운 계획서 제목 */
  title?: string
}

export function renderReport(state: NightState, o: ReportOptions = {}): string {
  const tasks = state.order.map((id) => state.tasks[id]!).filter(Boolean)
  const count = (st: string) => tasks.filter((t) => t.status === st).length
  const done = tasks.filter((t) => t.status === "done")
  const verified = done.filter((t) => t.verification === "passed")
  const unverified = done.filter((t) => t.verification !== "passed")

  const lines: string[] = []
  lines.push(`# 야간 작업 리포트${o.title ? ` — ${o.title}` : ""}`, "")
  lines.push(`- 시작: ${when(state.startedAt)}  /  예정 종료: ${when(state.deadline)}`)
  lines.push(
    state.status === "finished"
      ? `- 종료: ${when(state.finishedAt)} (${END_REASON[state.endReason ?? ""] ?? state.endReason ?? "-"})`
      : `- 상태: 진행 중 (이 문서는 작업이 끝날 때마다 갱신됩니다. 작성 시각 ${when((o.now ?? new Date()).toISOString())})`,
  )
  lines.push(
    `- 결과: 전체 ${tasks.length}개 중 **완료 ${count("done")}** (검증 통과 ${verified.length}, 검증 없음 ${unverified.length}) / **보류 ${count("held")}** / 건너뜀 ${count("skipped")} / 미실행 ${count("pending") + count("running")}`,
    "",
  )

  lines.push("## 작업별 결과", "", "| 작업 | 상태 | 검증 | 완료 기준 점검 | 시도 | 수정 | 소요 | 비고 |", "|---|---|---|---|---|---|---|---|")
  for (const t of tasks) {
    const note = t.status === "held" || t.status === "skipped" ? (t.reason ?? "") : t.needsReview.length ? `확인 필요: ${t.needsReview.join(", ")}` : ""
    lines.push(
      `| ${t.id} ${cell(t.title)} | ${STATUS_LABEL[t.status]} | ${VERIFY_LABEL[t.verification]} | ${CHECK_LABEL[t.selfCheck]} | ${t.attempts} | ${t.fixRounds} | ${dur(t.durationMs)} | ${cell(note)} |`,
    )
  }
  lines.push("")

  const held = tasks.filter((t) => t.status === "held" || t.status === "skipped")
  if (held.length) {
    lines.push("## 보류·건너뜀 작업", "")
    for (const t of held) {
      lines.push(`### ${t.id} ${t.title} — ${STATUS_LABEL[t.status]}`)
      lines.push(`- 사유: ${t.reason ?? "-"}`)
      if (t.lastError) lines.push(`- 마지막 오류:\n\n\`\`\`\n${t.lastError.trim().slice(-1500)}\n\`\`\``)
      if (t.heldDir) lines.push(`- 보류 직전 변경분 보관 위치: \`${t.heldDir}\` (작업 폴더는 작업 전 상태로 되돌렸습니다)`)
      for (const w of t.restoreWarnings) lines.push(`- ⚠ ${w}`)
      lines.push("")
    }
  }

  const review: string[] = []
  for (const t of done) {
    if (t.verification !== "passed") review.push(`${t.id} ${t.title}: 검증 명령이 없어 자동으로 검증하지 못했습니다. 직접 확인이 필요합니다.`)
    if (t.selfCheck === "unclear") review.push(`${t.id} ${t.title}: 완료 기준 점검 결과가 불명확했습니다${t.selfCheckNote ? ` (${t.selfCheckNote})` : ""}.`)
    for (const r of t.needsReview.filter((x) => !x.includes("검증 명령"))) review.push(`${t.id} ${t.title}: ${r}`)
  }
  if (review.length) {
    lines.push("## 사람이 확인할 항목", "", ...review.map((r) => `- ${r}`), "")
  }

  const oos = tasks.filter((t) => t.outOfScope.length)
  if (oos.length) {
    lines.push("## 계획서 범위를 벗어난 변경", "")
    for (const t of oos) lines.push(`- ${t.id}: ${t.outOfScope.map((p) => `\`${p}\``).join(", ")}`)
    lines.push("")
  }

  if (done.length) {
    lines.push("## 완료 작업의 변경 파일", "")
    for (const t of done) lines.push(`- ${t.id} ${t.title}: ${t.changedFiles.length ? t.changedFiles.map((p) => `\`${p}\``).join(", ") : "(변경 없음)"}`)
    lines.push("")
  }

  const m = (o.metrics ?? []).filter((x) => x.mode === "night" && x.at >= state.startedAt)
  if (m.length) {
    const ttft = percentile(m.map((x) => x.llm?.firstTokenMs ?? null).filter((v): v is number => v !== null), 50)
    const tps = percentile(m.map((x) => x.llm?.tokensPerSec ?? null).filter((v): v is number => v !== null), 50)
    const errors = m.reduce((a, x) => a + (x.llm?.errors ?? 0), 0)
    const waited = tasks.reduce((a, t) => a + t.waitedMs, 0)
    lines.push("## 속도·호출 요약", "")
    lines.push(`- 모델 실행 ${m.length}회, 호출 오류 ${errors}건, 서버 대기 시간 합계 ${dur(waited)}`)
    lines.push(`- 첫 토큰 중앙값 ${ttft === null ? "-" : dur(ttft)}, 초당 토큰 중앙값 ${tps === null ? "-" : tps}`, "")
  }

  if (state.events.length) {
    lines.push("## 진행 기록 (최근)", "")
    for (const e of state.events.slice(-60)) lines.push(`- ${new Date(e.at).toLocaleTimeString("ko-KR", { hour12: false })} ${e.message}`)
    lines.push("")
  }
  return lines.join("\n")
}

export function writeReport(layout: Layout, state: NightState, o: ReportOptions = {}): string {
  const text = renderReport(state, o)
  mkdirSync(layout.batch, { recursive: true })
  writeFileSync(reportPath(layout), text)
  return reportPath(layout)
}

export type { TaskState }
