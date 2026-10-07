// 간단한 로그 출력 (표준 에러로 출력해 표준 출력을 오염시키지 않는다)
export type LogLevel = "debug" | "info" | "warn" | "error"

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => console.error(l)) {
  const emit = (lv: LogLevel, msg: string) => {
    if (order[lv] < order[level]) return
    const ts = new Date().toISOString()
    sink(`[${ts}] ${lv.toUpperCase()} ${msg}`)
  }
  return {
    debug: (m: string) => emit("debug", m),
    info: (m: string) => emit("info", m),
    warn: (m: string) => emit("warn", m),
    error: (m: string) => emit("error", m),
  }
}

export type Logger = ReturnType<typeof createLogger>
