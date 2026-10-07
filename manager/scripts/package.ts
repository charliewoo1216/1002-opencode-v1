// 배포 폴더를 만든다: ocx + opencode + 예시 설정 + 안내문 + 매니페스트(해시)
// 사용: bun run scripts/package.ts --ocx <ocx 실행 파일> --opencode <opencode 실행 파일> [--target windows-x64] [--out dist]
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { exampleConfig } from "../src/config-doc"

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const fail = (msg: string): never => {
  console.error(`오류: ${msg}`)
  process.exit(1)
}

const root = join(import.meta.dir, "..")
const target = arg("target") ?? "windows-x64"
const isWin = target.startsWith("windows")
const ocx = resolve(arg("ocx") ?? fail("--ocx <ocx 실행 파일> 이 필요합니다"))
const opencode = resolve(arg("opencode") ?? fail("--opencode <opencode 실행 파일> 이 필요합니다"))
for (const f of [ocx, opencode]) if (!existsSync(f)) fail(`파일이 없습니다: ${f}`)
const outRoot = resolve(root, arg("out") ?? "dist")
const dir = join(outRoot, `ocx-${target}-package`)
mkdirSync(dir, { recursive: true })

const ocxName = isWin ? "ocx.exe" : "ocx"
const ocName = isWin ? "opencode.exe" : "opencode"
copyFileSync(ocx, join(dir, ocxName))
copyFileSync(opencode, join(dir, ocName))

// 예시 설정: opencode 실행 파일을 같은 폴더의 것으로 가리키게 한다
const example = JSON.parse(exampleConfig())
example.opencode = { command: [isWin ? ".\\opencode.exe" : "./opencode"] }
writeFileSync(join(dir, "ocx.config.example.json"), JSON.stringify(example, null, 2) + "\n")

const guide = join(root, "../docs/user-guide.md")
if (existsSync(guide)) {
  mkdirSync(join(dir, "docs"), { recursive: true })
  copyFileSync(guide, join(dir, "docs/user-guide.md"))
}
if (existsSync(join(root, "profiles"))) cpSync(join(root, "profiles"), join(dir, "profiles-example"), { recursive: true })

writeFileSync(
  join(dir, "README.txt"),
  // BOM을 붙여 Windows 메모장에서도 한글이 깨지지 않게 한다 (zip 안의 파일 이름은 한글 인코딩 문제를 피하려고 영문으로 둔다)
  "\uFEFF" +
    `ocx 사용 시작하기
==================

1. ocx.config.example.json 을 ocx.config.json 으로 복사한 뒤, models 의 baseURL / model 을 사내 LLM 서버에 맞게 고칩니다.
2. 점검:   ${ocxName} config check --online
3. 도움말: ${ocxName} --help      (명령별: ${ocxName} <명령> --help,  가이드: ${ocxName} guide)
4. 계획서: ${ocxName} plan --profile python "<몇 줄의 지시>"
5. 퇴근 전: ${ocxName} night       아침에: ${ocxName} report

이 폴더의 ${ocName} 는 ocx가 내부에서 사용하는 원본 OpenCode(폐쇄망 설정으로 빌드됨)입니다.
ocx 실행 파일과 ${ocName} 를 같은 폴더에 두거나, ocx.config.json 의 opencode.command 에 경로를 적으세요.
${isWin ? "\nWindows Terminal에서 실행하는 것을 권장합니다. 서명되지 않은 실행 파일이라 SmartScreen/백신 경고가 나올 수 있습니다.\n" : ""}
Git 명령은 ocx가 실행하지 않습니다. 커밋은 직접 하세요.
`,
)

// 매니페스트
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")
const files = [ocxName, ocName, "ocx.config.example.json", "README.txt"]
const manifest = [
  `ocx 배포 폴더 (${target})`,
  `만든 시각: ${new Date().toISOString()}`,
  "",
  ...files.map((f) => `${sha(join(dir, f)).slice(0, 16)}  ${(statSync(join(dir, f)).size / 1024).toFixed(0).padStart(8)}KB  ${f}`),
  "",
  "(해시는 SHA-256의 앞 16자리입니다)",
].join("\n")
writeFileSync(join(dir, "MANIFEST.txt"), manifest + "\n")
console.log(`배포 폴더를 만들었습니다: ${dir}\n${manifest}`)
void basename
