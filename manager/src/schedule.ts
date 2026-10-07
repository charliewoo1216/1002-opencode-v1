// 시간 계산: 야간 창, 종료 시각 (모두 로컬 시간 기준, 테스트에서 now를 주입할 수 있다)

export class TimeError extends Error {}

/** "HH:MM"을 분(0~1439)으로 */
export function parseClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) throw new TimeError(`시각 형식이 올바르지 않습니다: "${s}" (예: 07:00)`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) throw new TimeError(`시각 범위가 올바르지 않습니다: "${s}"`)
  return h * 60 + min
}

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes()

/** now 이후(같은 시각이면 다음 날)에 처음 오는 HH:MM 시각 */
export function nextOccurrence(now: Date, clock: string): Date {
  const target = parseClock(clock)
  const d = new Date(now)
  d.setHours(Math.floor(target / 60), target % 60, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

/** [start, end) 구간 안인지. 자정을 넘는 구간(19:00~07:00)도 처리한다 */
export function inWindow(now: Date, start: string, end: string): boolean {
  const s = parseClock(start)
  const e = parseClock(end)
  const n = minutesOfDay(now)
  if (s === e) return true // 하루 종일
  return s < e ? n >= s && n < e : n >= s || n < e
}

/** 야간 창이 열릴 때까지 기다려야 하는 시간(ms). 이미 열려 있으면 0 */
export function msUntilWindowOpens(now: Date, start: string, end: string): number {
  if (inWindow(now, start, end)) return 0
  return nextOccurrence(now, start).getTime() - now.getTime()
}

/**
 * 이번 실행의 종료 시각.
 * 창 안에서 시작하면 다음에 오는 end 시각, 창 밖에서 시작(--now)해도 다음에 오는 end 시각.
 */
export function deadlineFor(now: Date, end: string): Date {
  return nextOccurrence(now, end)
}

export const formatClock = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
