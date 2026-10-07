// CLI 공통 함수
import { resolve } from "node:path"
import type { Parsed } from "./args"
import { loadConfig, type OcxConfig } from "./config"

export function configPath(flags: Parsed["flags"]): string {
  return resolve(String(flags.config ?? process.env.OCX_CONFIG ?? "ocx.config.json"))
}

/** 설정을 읽는다. 오류(ConfigError)는 main에서 한글 안내로 처리한다 */
export function loadCfg(flags: Parsed["flags"]): OcxConfig {
  return loadConfig(configPath(flags))
}

