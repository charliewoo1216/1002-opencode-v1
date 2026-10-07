// 승인된 계획서의 작업 하나를 모델에게 맡길 지시문으로 만든다 (낮 모드·밤 모드 공통)
// 작업을 시작할 때마다 의도 계획서의 핵심(목적, 범위, 비목표)을 다시 넣어 의도에서 벗어나지 않게 한다.
import { readFileSync } from "node:fs"
import type { Layout } from "./paths"
import { intentPath, parseTaskPlan, sectionOf, tasksPath, type PlanTask } from "./plan"

export function intentDigest(intentMd: string): string {
  const pick = (h: string) => {
    const body = sectionOf(intentMd, h)?.trim()
    return body ? `[${h}]\n${body}` : ""
  }
  return ["목적", "범위", "비목표"].map(pick).filter(Boolean).join("\n\n")
}

export function taskGoal(intentMd: string, t: PlanTask): string {
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- (없음)")
  return `다음은 사용자가 승인한 작업 계획의 일부입니다. 이 작업만 수행하세요. 계획의 의도와 비목표를 벗어나는 변경은 하지 마세요.

${intentDigest(intentMd)}

[이번 작업] ${t.id}: ${t.title}
유형: ${t.type}
설명: ${t.description}
대상 파일:
${list(t.files)}
완료 기준:
${list(t.criteria)}
검증 명령(작업을 끝내기 전에 직접 실행해서 통과를 확인하세요):
${list(t.verify)}`
}

export interface LoadedTask {
  task: PlanTask
  goal: string
}

/** 작업 계획서에서 id로 작업을 찾아 지시문까지 만든다 */
export function loadTask(layout: Layout, id: string): LoadedTask {
  const intent = readFileSync(intentPath(layout), "utf8")
  const { tasks } = parseTaskPlan(readFileSync(tasksPath(layout), "utf8"))
  const task = tasks.find((t) => t.id === id)
  if (!task) throw new Error(`작업 계획서에 "${id}" 작업이 없습니다. 있는 작업: ${tasks.map((t) => t.id).join(", ")}`)
  return { task, goal: taskGoal(intent, task) }
}
