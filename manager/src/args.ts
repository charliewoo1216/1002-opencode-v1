// 명령줄 인자 파서 (의존성 없이 단순 파싱)
export interface Parsed {
  command: string | undefined
  flags: Record<string, string | boolean>
  positionals: string[]
}

const BOOLEAN_FLAGS = new Set(["continue", "auto", "help", "json", "no-proxy", "no-analyze", "yes", "approve", "status", "light", "resume", "now", "dry-run", "retry-held", "online"])

/** 의존성 없이 단순 파싱: --키 값, --키(불리언), -- 이후는 전부 위치 인자 */
export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let command: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const name = a.slice(2)
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true
      else flags[name] = argv[++i] ?? ""
    } else if (command === undefined) {
      command = a
    } else {
      positionals.push(a)
    }
  }
  return { command, flags, positionals }
}

