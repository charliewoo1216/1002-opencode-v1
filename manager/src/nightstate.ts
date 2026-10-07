// 밤 모드 상태 저장소 (디스크). 프로그램·PC가 중간에 꺼져도 다시 실행하면 이어서 한다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Layout } from "./paths"

export type TaskStatus = "pending" | "running" | "done" | "held" | "skipped"
export type Verification = "passed" | "failed" | "none"
export type SelfCheck = "pass" | "fail" | "unclear" | "off"

export interface VerifyRun {
  at: string
  ok: boolean
  summary: string
}

export interface TaskState {
  id: string
  title: string
  status: TaskStatus
  /** 구현 시도(감독 실행 포함) 횟수 합계 */
  attempts: number
  /** 검증 실패 후 수정한 횟수 */
  fixRounds: number
  startedAt?: string
  finishedAt?: string
  durationMs: number
  verification: Verification
  verifyRuns: VerifyRun[]
  selfCheck: SelfCheck
  selfCheckNote?: string
  /** 보류·건너뜀 사유 */
  reason?: string
  lastError?: string
  /** 이 작업에서 바뀐 파일 */
  changedFiles: string[]
  /** 계획서 범위를 벗어난 변경 */
  outOfScope: string[]
  /** 보류 시 변경분을 보관한 폴더 */
  heldDir?: string
  /** 백업 한계 등 복원 관련 경고 */
  restoreWarnings: string[]
  /** 계획서 검증에서 사람 확인이 필요하다고 표시된 사유 */
  needsReview: string[]
  /** 서버 장애 등으로 기다린 총 시간(ms) */
  waitedMs: number
}

export type EndReason = "all-done" | "deadline" | "all-held" | "aborted"

export interface NightState {
  version: 1
  /** 승인된 계획서 해시 (계획서가 바뀌면 이어하기 불가) */
  planHash: string
  startedAt: string
  deadline: string
  status: "running" | "finished"
  endReason?: EndReason
  finishedAt?: string
  order: string[]
  tasks: Record<string, TaskState>
  /** 알림과 진행 기록 (최근 것만) */
  events: Array<{ at: string; message: string }>
}

export const nightStatePath = (l: Layout) => join(l.batch, "night-state.json")

export function newTaskState(id: string, title: string, needsReview: string[] = []): TaskState {
  return {
    id,
    title,
    status: "pending",
    attempts: 0,
    fixRounds: 0,
    durationMs: 0,
    verification: "none",
    verifyRuns: [],
    selfCheck: "off",
    changedFiles: [],
    outOfScope: [],
    restoreWarnings: [],
    needsReview,
    waitedMs: 0,
  }
}

/** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중에 꺼져도 파일이 깨지지 않게 한다 */
export function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

export function saveNightState(layout: Layout, state: NightState) {
  writeJsonAtomic(nightStatePath(layout), state)
}

export function loadNightState(layout: Layout): NightState | null {
  const p = nightStatePath(layout)
  if (!existsSync(p)) return null
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as NightState
    return s.version === 1 ? s : null
  } catch {
    return null
  }
}

const MAX_EVENTS = 500

export function addEvent(state: NightState, message: string, now = new Date()) {
  state.events.push({ at: now.toISOString(), message })
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
}

/**
 * 이전 실행 상태를 이어받을 때의 정리: 실행 중이던 작업(비정상 종료로 남은 것)은 다시 대기로 돌린다.
 * retryHeld가 true면 보류·건너뜀 작업도 다시 시도한다.
 */
export function prepareResume(state: NightState, opts: { retryHeld: boolean }): string[] {
  const notes: string[] = []
  for (const t of Object.values(state.tasks)) {
    if (t.status === "running") {
      t.status = "pending"
      notes.push(`${t.id}: 이전 실행이 도중에 끊겨 처음부터 다시 시작합니다`)
    } else if (opts.retryHeld && (t.status === "held" || t.status === "skipped")) {
      t.status = "pending"
      t.reason = undefined
      t.fixRounds = 0
      notes.push(`${t.id}: 보류/건너뜀 작업을 다시 시도합니다`)
    }
  }
  return notes
}
