// 감독자 (낮 모드의 핵심): 사용자가 수동으로 하던 "느리면 중단하고 다시 시작"을 자동화한다
// 시도마다 이상 징후(정체, 루프, 시간 초과)를 감지하고, 단계적으로 대응한다.
//   1단계: 같은 세션으로 이어서 진행
//   2단계: 새 세션 + 지금까지의 진행 상태 요약만 전달 (입력을 가볍게)
//   3단계: 더 이어갈 수 없으면 보류하고 알린다
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { DayConfig } from "./config"
import type { RunResult } from "./runner"
import { changedPaths, diffSnapshots, type Snapshot } from "./snapshot"

export type AbortReason = "stall" | "loop" | "budget"

export interface AttemptSpec {
  n: number
  kind: "fresh" | "continue"
  prompt: string
  /** kind가 continue일 때 이어갈 세션 */
  sessionID?: string
  /** 가볍게 실행할지 (사고 모드 끄기 등) */
  light: boolean
}

export interface AttemptOutcome {
  result: RunResult
  abortedBy: AbortReason | null
  abortDetail?: string
  /** 이 시도에서 관측한 가장 큰 프롬프트 토큰 수 (컨텍스트 사용량 판단용) */
  maxPromptTokens: number | null
  /** 실패 시 다음 시도에 넘길 마지막 상태 요약 */
  tail: string
}

export type AttemptRunner = (spec: AttemptSpec) => Promise<AttemptOutcome>

export interface AttemptRecord {
  n: number
  kind: "fresh" | "continue"
  light: boolean
  endedBy: string
  reason: string | null
  durationMs: number
  promptTokens: number | null
  changedFiles: string[]
  sessionID?: string
}

export interface SuperviseResult {
  status: "done" | "held"
  attempts: AttemptRecord[]
  text: string
  sessionID?: string
  /** 사용자에게 알릴 내용 (전환 이유 등) */
  notices: string[]
  /** 전체 과정에서 바뀐 파일 */
  changedFiles: string[]
}

export interface SuperviseOptions {
  goal: string
  policy: DayConfig
  runAttempt: AttemptRunner
  contextLimit: number
  takeSnapshot: () => Snapshot
  notify?: (message: string) => void
  /** 진행 상태를 저장할 파일 (JSON). 생략하면 저장하지 않음 */
  stateFile?: string
  /** 처음부터 가볍게 실행 */
  light?: boolean
  /** 재개: 첫 시도를 이 값으로 시작한다 (이전 실행의 세션을 이어가는 경우 등) */
  initial?: Partial<AttemptSpec>
  /** 재개: 이전 실행에서 이미 한 시도 기록 */
  priorAttempts?: AttemptRecord[]
  /** 다음 시도를 시작하기 전에 확인한다. 사유 문자열을 돌려주면 더 시도하지 않고 보류한다 (종료 시각 도달 등) */
  stopWhen?: () => string | null
}

/** 시도 결과가 실패라면 사유를, 성공이면 null */
export function failureReason(o: AttemptOutcome): string | null {
  if (o.abortedBy === "stall") return o.abortDetail ?? "응답이 멈춤"
  if (o.abortedBy === "loop") return o.abortDetail ?? "같은 동작이 반복됨"
  if (o.abortedBy === "budget") return o.abortDetail ?? "시간 예산을 넘김"
  const r = o.result
  if (r.endedBy === "timeout") return "총 시간 제한을 넘김"
  if (r.endedBy === "stall") return "출력이 멈춤"
  if (r.endedBy === "aborted") return "중단됨"
  if (r.exitCode !== 0) return `비정상 종료(코드 ${r.exitCode ?? "없음"})${r.stderrTail ? `: ${r.stderrTail.trim().split("\n").slice(-1)[0]}` : ""}`
  if (r.events.length === 0 && !r.text.trim()) return "응답이 비어 있음"
  return null
}

export function continuePrompt(reason: string): string {
  return `이전 실행이 "${reason}" 때문에 중단되었습니다. 같은 작업을 이어서 계속하세요. 이미 끝낸 부분은 다시 하지 말고, 먼저 현재 상태를 확인한 뒤 남은 부분만 진행하세요.`
}

export function summaryPrompt(o: { goal: string; reason: string; changed: string[]; tail: string }): string {
  const files = o.changed.length ? o.changed.map((f) => `- ${f}`).join("\n") : "- (아직 변경된 파일 없음)"
  return `원래 지시:
${o.goal.trim()}

이전 시도가 "${o.reason}" 때문에 중단되어 새 세션으로 이어서 진행합니다.

지금까지 바뀐 파일:
${files}
${o.tail.trim() ? `\n중단 직전 상태:\n${o.tail.trim()}\n` : ""}
이미 반영된 변경은 다시 하지 마세요. 먼저 위 파일들의 현재 내용을 확인하고, 원래 지시 중 남은 부분만 진행하세요.`
}

export async function supervise(o: SuperviseOptions): Promise<SuperviseResult> {
  const { policy } = o
  const baseline = o.takeSnapshot()
  const result: SuperviseResult = { status: "held", attempts: [...(o.priorAttempts ?? [])], text: "", notices: [], changedFiles: [] }
  const say = (m: string) => {
    result.notices.push(m)
    o.notify?.(m)
  }
  const save = () => {
    if (!o.stateFile) return
    mkdirSync(dirname(o.stateFile), { recursive: true })
    writeFileSync(o.stateFile, JSON.stringify({ goal: o.goal, ...result, updatedAt: new Date().toISOString() }, null, 2))
  }

  let spec: AttemptSpec = { n: 1, kind: "fresh", prompt: o.goal, light: o.light ?? false, ...o.initial }
  for (;;) {
    const started = Date.now()
    const out = await o.runAttempt(spec)
    const reason = failureReason(out)
    const changed = changedPaths(diffSnapshots(baseline, o.takeSnapshot()))
    result.changedFiles = changed
    result.sessionID = out.result.sessionID ?? result.sessionID
    result.attempts.push({
      n: spec.n,
      kind: spec.kind,
      light: spec.light,
      endedBy: out.abortedBy ?? out.result.endedBy,
      reason,
      durationMs: Date.now() - started,
      promptTokens: out.maxPromptTokens,
      changedFiles: changed,
      sessionID: out.result.sessionID,
    })
    if (reason === null) {
      result.status = "done"
      result.text = out.result.text
      save()
      return result
    }

    say(`시도 ${spec.n} 중단: ${reason}`)
    const stop = o.stopWhen?.()
    if (stop) {
      result.status = "held"
      result.text = out.result.text
      say(`더 시도하지 않고 보류합니다: ${stop}`)
      save()
      return result
    }
    if (spec.n >= policy.maxAttempts) {
      result.status = "held"
      result.text = out.result.text
      say(`최대 시도 횟수(${policy.maxAttempts})에 도달해 보류합니다. 변경된 파일 ${changed.length}개는 그대로 남아 있습니다.`)
      save()
      return result
    }

    // 다음 시도 결정
    const ratio = out.maxPromptTokens !== null ? out.maxPromptTokens / o.contextLimit : 0
    const contextHeavy = ratio >= policy.contextRenewRatio
    const isLoop = out.abortedBy === "loop"
    const canContinue = spec.kind === "fresh" && !contextHeavy && !isLoop && !!out.result.sessionID
    const next: AttemptSpec = canContinue
      ? { n: spec.n + 1, kind: "continue", sessionID: out.result.sessionID, prompt: continuePrompt(reason), light: true }
      : {
          n: spec.n + 1,
          kind: "fresh",
          prompt: summaryPrompt({ goal: o.goal, reason, changed, tail: out.tail }),
          light: true,
        }
    if (!canContinue) {
      say(
        contextHeavy
          ? `컨텍스트 사용량이 ${(ratio * 100).toFixed(0)}%라 새 세션으로 이어갑니다.`
          : isLoop
            ? "반복을 끊기 위해 새 세션으로 이어갑니다."
            : "같은 세션 이어하기가 어려워 새 세션으로 이어갑니다.",
      )
    } else {
      say("같은 세션으로 이어서 진행합니다.")
    }
    spec = next
    save()
  }
}
