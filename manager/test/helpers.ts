import { existsSync } from "node:fs"
import { AUTO_DEFAULTS, DAY_DEFAULTS, NIGHT_DEFAULTS, type OcxConfig } from "../src/config"

/** 테스트용 설정: 원본 opencode 대신 가짜 opencode를 실행한다 */
export function fakeConfig(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    opencode: { command: ["bun", "run", `${import.meta.dir}/fake-opencode.ts`] },
    models: {
      a: { baseURL: "http://127.0.0.1:18000/v1", model: "model-a", apiKey: "EMPTY", contextLimit: 32768, outputLimit: 4096 },
      b: { baseURL: "http://127.0.0.1:18001/v1", model: "model-b", apiKey: "EMPTY", contextLimit: 16384, outputLimit: 2048 },
    },
    defaultModel: "a",
    closedNetwork: true,
    referenceDir: "reference",
    day: { ...DAY_DEFAULTS },
    night: { ...NIGHT_DEFAULTS },
    auto: { ...AUTO_DEFAULTS },
    safety: { extraBlocked: [] },
    ...extra,
  }
}

export const ev = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: Date.now(), sessionID: "ses_test", part: { type, ...extra } })

/**
 * 통합·end-to-end 테스트가 실행할 원본 opencode.
 *  - OCX_OPENCODE_BIN: 컴파일된 실행 파일 경로 (배포 형태 검증)
 *  - OCX_OPENCODE_SRC: 소스 진입점 (기본 /home/user/sst/opencode/packages/opencode/src/index.ts)
 * 둘 다 없으면 해당 테스트는 건너뛴다.
 */
export const OPENCODE_SRC = process.env.OCX_OPENCODE_SRC ?? "/home/user/sst/opencode/packages/opencode/src/index.ts"
export const OPENCODE_BIN = process.env.OCX_OPENCODE_BIN
export const OPENCODE_CMD: string[] = OPENCODE_BIN ? [OPENCODE_BIN] : ["bun", "run", OPENCODE_SRC]
export const OPENCODE_AVAILABLE = OPENCODE_BIN ? existsSync(OPENCODE_BIN) : existsSync(OPENCODE_SRC)
