// 가짜 opencode (러너 테스트 전용)
// 환경변수 FAKE_PLAN: [{ delayMs, line }] — 각 항목을 지연 후 표준 출력으로 내보낸다
// 환경변수 FAKE_ARGS_FILE: 받은 인자와 일부 환경변수를 JSON으로 기록
// 환경변수 FAKE_EXIT: 종료 코드 (기본 0)
import { writeFileSync } from "node:fs"

const plan: Array<{ delayMs?: number; line: string }> = JSON.parse(process.env.FAKE_PLAN ?? "[]")
if (process.env.FAKE_ARGS_FILE) {
  writeFileSync(
    process.env.FAKE_ARGS_FILE,
    JSON.stringify({
      args: process.argv.slice(2),
      env: {
        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
        OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH,
      },
    }),
  )
}
for (const step of plan) {
  if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
  console.log(step.line)
}
process.exit(Number(process.env.FAKE_EXIT ?? 0))
