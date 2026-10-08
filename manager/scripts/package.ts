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

// 예시 설정: opencode.command 를 생략해 두면 ocx 와 같은 폴더의 opencode(.exe)를 자동으로 쓴다
const example = JSON.parse(exampleConfig())
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

명령 이름은 ocx 입니다 (${ocxName}). 원본 opencode 와 같이 프로젝트 폴더의 터미널(VS Code 터미널 포함)에서 실행합니다.

[필수] 설치 위치는 C:\\Markany\\opencode 하나뿐입니다.
   사내 보안(DRM) 정책상 모든 파일은 C:\\Markany\\opencode 에만 두세요. 바탕화면·다운로드·프로젝트 폴더 등 다른 경로에 풀거나 복사하면 안 됩니다.
   (C:\\Markany\\opencode\\${ocxName} 가 되도록 압축 내용물을 그대로 푸세요.)

1. PATH 등록 (한 번만)
   이 폴더 C:\\Markany\\opencode (${ocxName} 와 ${ocName} 가 있는 폴더)를 Windows PATH 에 추가하세요.
   시작 메뉴 "환경 변수" 검색 → 계정에 대한 환경 변수 편집 → 사용자 변수 Path → 새로 만들기 → 이 폴더 경로.
   등록 후 VS Code 를 완전히 종료했다가 다시 실행하세요.
   (ocx 는 기본으로 이 폴더의 ${ocName} 를 씁니다. PATH 에 이미 있는 opencode 를 쓰려면 설정에 "opencode": { "command": ["opencode"] } 를 적으세요.)

2. 설정 파일 (한 곳에 두고 모든 프로젝트가 같이 쓰기)
   ocx.config.example.json 을 C:\\Markany\\opencode\\ocx.config.json 으로 복사하고, models 의 baseURL / model 을 사내 LLM 서버에 맞게 고칩니다.
   사용자 환경 변수 OCX_CONFIG 를 그 파일의 전체 경로로 지정하면 어느 프로젝트에서든 설정을 찾습니다.
   (프로젝트마다 다르게 쓰려면 그 프로젝트 폴더에 ocx.config.json 을 두거나 --config 파일 을 지정)

3. 프로젝트에서 쓰기 (VS Code 로 프로젝트를 열고 터미널에서)
   ocx config check --online          설정과 서버 연결 점검
   ocx --help                          도움말 (명령별: ocx <명령> --help,  가이드: ocx guide)
   ocx day "한 가지 작업 지시"            낮: 멈추면 자동으로 이어서/새 세션으로 재시도
   ocx plan --profile python "지시"     계획서 만들기
   ocx night                            퇴근 전에 걸어 두면 밤새 진행   →  아침에: ocx report

[ocx 가 아무 출력 없이 끝날 때]
   별도 파일 ocx-probe.zip (진단 프로그램)을 받아 같은 폴더 C:\\Markany\\opencode 에 풀고  .\\ocx-probe.exe  를 실행하세요. 단계별 결과가 화면과 ocx-probe.log 에 남습니다.
   (그 결과와 ocx.exe version 의 종료 코드(echo %ERRORLEVEL%)를 알려 주세요.)

프로젝트 폴더에는 .plan/ .notes/ .batch/ 폴더가 만들어집니다. Git 에 올리지 않으려면 .gitignore 에 추가하세요.

${ocName} 는 ocx 가 내부에서 사용하는 원본 OpenCode(폐쇄망 설정으로 빌드됨)입니다.
${isWin ? "\nWindows Terminal 또는 VS Code 터미널에서 실행하세요. 서명되지 않은 실행 파일이라 SmartScreen/백신 경고가 나올 수 있습니다.\n" : ""}
Git 명령은 ocx가 실행하지 않습니다. 커밋은 직접 하세요.
`,
)

// 매니페스트
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")
const files = [ocxName, ocName, "ocx.config.example.json", "README.txt"]
const manifest = [
  `ocx 배포 폴더 (${target}${basename(ocx).includes("baseline") ? ", baseline 빌드: AVX2 가 없는 CPU 에서도 동작" : ""})`,
  `만든 시각: ${new Date().toISOString()}`,
  "",
  ...files.map((f) => `${sha(join(dir, f)).slice(0, 16)}  ${(statSync(join(dir, f)).size / 1024).toFixed(0).padStart(8)}KB  ${f}`),
  "",
  "(해시는 SHA-256의 앞 16자리입니다)",
].join("\n")
writeFileSync(join(dir, "MANIFEST.txt"), manifest + "\n")
console.log(`배포 폴더를 만들었습니다: ${dir}\n${manifest}`)
