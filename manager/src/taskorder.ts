// 작업 선택 순서 (빠른 시간대 활용 옵션)
// 기본은 계획서 순서대로. 옵션을 켜면 서버가 빠른 시간대(예: 새벽)에는 무거운 작업을, 그 밖에는 가벼운 작업을 먼저 고른다.
// 의존 관계가 풀린(실행 가능한) 작업들 사이에서만 순서를 바꾸므로 계획서의 의존 순서는 항상 지켜진다.
import type { PlanTask } from "./plan"

/** 작업의 무게: 대상 파일·완료 기준·검증 명령이 많고 설명이 길수록, MCP 작업이면 무겁다 */
export function taskWeight(t: PlanTask): number {
  return t.files.length + t.criteria.length + t.verify.length + (t.type === "MCP" ? 3 : 0) + Math.min(3, Math.floor(t.description.length / 200))
}

/** ready는 계획서 순서로 정렬된 실행 가능 작업들. enabled가 꺼져 있으면 항상 첫 번째 */
export function pickReady(ready: PlanTask[], o: { enabled: boolean; inFastWindow: boolean }): PlanTask | undefined {
  if (ready.length === 0) return undefined
  if (!o.enabled) return ready[0]
  let best = ready[0]!
  for (const t of ready.slice(1)) {
    const better = o.inFastWindow ? taskWeight(t) > taskWeight(best) : taskWeight(t) < taskWeight(best)
    if (better) best = t // 같은 무게면 계획서 순서가 앞선 것을 유지
  }
  return best
}
