// 자체 점검 패스: 검증 명령이 통과한 뒤에도, 계획서의 완료 기준을 실제 파일과 대조해 한 번 더 확인한다
import type { PlanTask } from "./plan"

export type SelfCheckVerdict = { kind: "pass" } | { kind: "fail"; reason: string } | { kind: "unclear"; note: string }

export function selfCheckPrompt(task: PlanTask, changedFiles: string[]): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (없음)")
  return `다음 작업이 끝났다고 보고되었습니다. 완료 기준이 실제로 충족되었는지 점검하세요.

[작업] ${task.id}: ${task.title}
설명: ${task.description}
대상 파일:
${list(task.files)}
이번 작업에서 바뀐 파일:
${list(changedFiles)}

완료 기준:
${task.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

바뀐 파일과 관련 파일을 직접 읽어서 기준을 하나씩 확인하세요. 읽지 않고 추측하지 마세요.
마지막 줄은 반드시 "점검결과: 통과" 또는 "점검결과: 미흡 - (이유)" 형식이어야 합니다.`
}

/** 점검 응답의 마지막 "점검결과" 줄을 해석한다. 없으면 불명확 */
export function parseSelfCheck(text: string): SelfCheckVerdict {
  const all = [...text.matchAll(/점검\s*결과\s*[:：]\s*(통과|미흡)(?:\s*[-–—:]\s*([^\n]*))?/g)]
  const last = all.at(-1)
  if (!last) return { kind: "unclear", note: "점검 결과 줄이 없습니다" }
  if (last[1] === "통과") return { kind: "pass" }
  return { kind: "fail", reason: (last[2] ?? "").trim() || "이유가 적혀 있지 않습니다" }
}
