// 반복(루프) 감지: 같은 도구 호출이나 같은 오류가 연속으로 되풀이되면 알린다
import type { OpencodeEvent } from "./runner"

export class LoopDetector {
  private lastCall = ""
  private callRepeat = 0
  private lastError = ""
  private errorRepeat = 0

  constructor(private readonly threshold: number) {}

  /** 이벤트를 하나 넣는다. 루프로 판단되면 사유 문자열을, 아니면 null을 돌려준다 */
  feed(ev: OpencodeEvent): string | null {
    if (ev.type !== "tool_use") return null
    const part = ev.part ?? {}
    const tool = String(part.tool ?? "?")
    const state = (part.state ?? {}) as Record<string, any>
    // 아직 끝나지 않은 도구 호출 이벤트는 건너뛴다 (완료/오류 시점에만 센다)
    if (state.status !== "completed" && state.status !== "error") return null

    const callKey = `${tool}:${JSON.stringify(state.input ?? {})}`
    if (callKey === this.lastCall) this.callRepeat++
    else {
      this.lastCall = callKey
      this.callRepeat = 1
    }
    if (this.callRepeat >= this.threshold) return `같은 도구 호출(${tool})이 ${this.callRepeat}번 연속 반복됨`

    if (state.status === "error") {
      const errKey = `${tool}:${String(state.error ?? state.output ?? "").slice(0, 200)}`
      if (errKey === this.lastError) this.errorRepeat++
      else {
        this.lastError = errKey
        this.errorRepeat = 1
      }
      if (this.errorRepeat >= this.threshold) return `같은 오류(${tool})가 ${this.errorRepeat}번 연속 반복됨`
    } else {
      this.lastError = ""
      this.errorRepeat = 0
    }
    return null
  }
}
