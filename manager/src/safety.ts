// 안전 규칙 (모든 모드 공통)
// - Git 명령은 전부 금지 (Git은 사용자가 수동으로 처리)
// - 되돌릴 수 없는 위험 명령, 외부 배포·전송 명령 금지
// 이 규칙은 두 곳에 적용된다.
//   1) 검증 명령 실행기(ocx가 직접 실행하는 명령): guardCommand
//   2) 원본 opencode의 bash 도구: bashPermissionRules (원본 권한 설정으로 주입)

export interface GuardOptions {
  /** 사용자가 설정으로 추가한 금지 명령(첫 단어 기준) */
  extraBlocked?: string[]
}

/** 명령줄을 &&, ||, ;, |, 줄바꿈, $( ), 백틱 기준으로 쪼갠다 */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n|\$\(|\)|`/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "xargs", "builtin"])

/** 환경변수 대입과 래퍼 명령을 건너뛰고 실제 실행 단어와 인자를 돌려준다 */
export function commandWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++
    else break
  }
  return words.slice(i).map((w) => w.replace(/^["'(]+|["')]+$/g, ""))
}

const baseName = (w: string) => w.replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, "")

const NETWORK_TOOLS = new Set(["curl", "wget", "ssh", "scp", "sftp", "telnet", "ftp", "nc", "ncat"])
const DISK_TOOLS = new Set(["mkfs", "fdisk", "parted", "format", "diskpart"])
const POWER_TOOLS = new Set(["shutdown", "reboot", "halt", "poweroff", "init"])
const PRIV_TOOLS = new Set(["sudo", "su", "doas", "runas"])

const DANGEROUS_RM_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}", "..", "../", "../*", ".", "./", "*", "./*", "C:\\", "C:/"])

/** 허용하지 않는 명령이면 사유를, 허용되면 null */
export function guardCommand(command: string, o: GuardOptions = {}): string | null {
  const extra = new Set((o.extraBlocked ?? []).map((s) => s.toLowerCase()))
  for (const seg of splitSegments(command)) {
    const words = commandWords(seg)
    if (words.length === 0) continue
    const cmd = baseName(words[0]!)
    const args = words.slice(1)

    if (cmd === "git") return "Git 명령은 허용되지 않습니다 (Git은 사용자가 수동으로 처리합니다)"
    if (extra.has(cmd)) return `설정에서 금지한 명령입니다: ${cmd}`
    if (PRIV_TOOLS.has(cmd)) return `권한 상승 명령은 허용되지 않습니다: ${cmd}`
    if (POWER_TOOLS.has(cmd)) return `시스템 종료·재시작 명령은 허용되지 않습니다: ${cmd}`
    if (DISK_TOOLS.has(cmd) || cmd.startsWith("mkfs")) return `디스크를 바꾸는 명령은 허용되지 않습니다: ${cmd}`
    if (cmd === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return "장치에 직접 쓰는 명령은 허용되지 않습니다"

    if (cmd === "rm" || cmd === "rmdir" || cmd === "del" || cmd === "rd") {
      const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^\/s$/i.test(a) || a === "--recursive")
      if (recursive && args.some((a) => DANGEROUS_RM_TARGETS.has(a) || /^\/(usr|etc|bin|lib|var|home|root|opt|boot|dev|sys|proc)(\/|$)/.test(a))) {
        return "작업 폴더 전체나 시스템 경로를 지우는 명령은 허용되지 않습니다"
      }
    }
    if (cmd === "chmod" || cmd === "chown") {
      if (args.some((a) => a === "-R" || a === "-r") && args.some((a) => a === "/" || a === "/*")) return "시스템 경로의 권한을 바꾸는 명령은 허용되지 않습니다"
    }
    if (NETWORK_TOOLS.has(cmd)) {
      // 같은 PC의 서버(MCP 서버 테스트 등)로 가는 호출만 허용
      const local = args.some((a) => /(^|\/\/|@)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(a))
      if (!local) return `외부 네트워크 명령은 허용되지 않습니다 (폐쇄망): ${cmd}`
    }
    // 외부로 배포·전송하는 명령
    const joined = `${cmd} ${args.join(" ")}`
    if (/^(npm|pnpm|yarn)\s+publish\b/.test(joined) || /^twine\s+upload\b/.test(joined) || /^docker\s+push\b/.test(joined) || /^(mvn|\.\/mvnw|mvnw)\s.*\bdeploy\b/.test(joined) || /^(gradle|\.\/gradlew|gradlew)\s.*\bpublish/.test(joined)) {
      return "외부로 배포하는 명령은 허용되지 않습니다"
    }
  }
  return null
}

/**
 * 원본 opencode의 bash 권한 규칙. 원본은 복합 명령을 개별 명령으로 나눠 검사하므로(실측으로 확인)
 * 명령 단어 기준 패턴으로 충분하다.
 */
export function bashPermissionRules(o: GuardOptions = {}): Record<string, "allow" | "deny"> {
  const deny = ["git", "sudo", "su", "doas", "shutdown", "reboot", "halt", "poweroff", "mkfs*", "fdisk", "diskpart", ...(o.extraBlocked ?? [])]
  const rules: Record<string, "allow" | "deny"> = { "*": "allow" }
  for (const c of deny) {
    rules[c] = "deny"
    rules[`${c} *`] = "deny"
    // 환경변수 대입이 앞에 붙은 형태 (FOO=1 git ...). 원본은 이런 형태를 첫 단어 기준으로 보지 않아 실측에서 통과했다.
    rules[`*=* ${c}`] = "deny"
    rules[`*=* ${c} *`] = "deny"
    // 래퍼 명령 (env git ..., nohup git ...)
    for (const w of ["env", "nohup", "time", "command", "xargs", "exec", "builtin"]) {
      rules[`${w} ${c}`] = "deny"
      rules[`${w} ${c} *`] = "deny"
    }
    // 셸을 한 번 더 거치는 형태 (sh -c "git ...")
    for (const sh of ["sh -c", "bash -c", "zsh -c", "cmd /c", "cmd.exe /c", "powershell -c", "powershell -Command"]) {
      rules[`${sh} *${c} *`] = "deny"
      rules[`${sh} *${c}`] = "deny"
    }
  }
  for (const c of ["curl", "wget", "ssh", "scp", "sftp", "telnet", "ftp", "nc", "ncat"]) {
    rules[c] = "deny"
    rules[`${c} *`] = "deny"
    // 같은 PC의 서버로 가는 호출은 허용 (뒤에 오는 규칙이 우선)
    rules[`${c} *localhost*`] = "allow"
    rules[`${c} *127.0.0.1*`] = "allow"
  }
  for (const pat of ["rm -rf /*", "rm -rf ~*", "rm -rf .", "rm -rf ..", "rm -fr /*", "rm -fr ~*", "npm publish*", "twine upload*", "docker push*"]) rules[pat] = "deny"
  return rules
}

export interface SafetyPermissionOptions extends GuardOptions {
  /**
   * 사람이 화면 앞에서 쓰는 대화형(TUI) 실행이면 true.
   * 무인 실행은 작업 폴더 밖 접근을 항상 거부하고(--auto로 승인 요청을 자동 승인하는 경우에도 막힘),
   * 대화형은 원본 기본값(사용자에게 확인)을 그대로 둔다.
   */
  interactive?: boolean
}

/** 원본 opencode에 주입할 권한 설정 (폐쇄망 웹 도구 차단 + 안전 규칙 + 작업 폴더 한정) */
export function safetyPermission(o: SafetyPermissionOptions = {}): Record<string, unknown> {
  return {
    bash: bashPermissionRules(o),
    webfetch: "deny",
    websearch: "deny",
    ...(o.interactive ? {} : { external_directory: "deny" }),
  }
}
