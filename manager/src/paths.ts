// 작업 폴더 내 관리 프로그램 전용 경로 규약
import { join } from "node:path"

export interface Layout {
  root: string
  /** 의도 계획서, 작업 계획서, 승인 기록 */
  plan: string
  /** 참조 분석 노트와 색인 */
  notes: string
  /** 진행 상태, 속도 기록, 백업, 리포트 */
  batch: string
  metricsFile: string
}

export function layoutFor(root: string): Layout {
  const batch = join(root, ".batch")
  return {
    root,
    plan: join(root, ".plan"),
    notes: join(root, ".notes"),
    batch,
    metricsFile: join(batch, "metrics.jsonl"),
  }
}
