// 원본 opencode(업스트림 클론)를 대상 플랫폼용 실행 파일로 빌드한다.
// 업스트림 build.ts 는 타깃을 고를 수 없고(--single 은 현재 플랫폼만), 빌드 때 models.dev 에서 받은 응답을
// 상태 코드 확인 없이 실행 파일에 내장한다(접속이 막히면 오류 본문이 내장되어 실행이 전부 실패함).
// 이 스크립트는 (1) 업스트림 build.ts 를 수정하지 않고 타깃만 고르는 사본을 만들고 (2) 유효한 빈 모델 스냅샷을 지정한다.
//
// 사용: bun run scripts/build-opencode.ts --src <업스트림 폴더> [--target windows-x64|windows-x64-baseline|linux-x64] [--out dist] [--skip-install]
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const fail = (msg: string): never => {
  console.error(`오류: ${msg}`)
  process.exit(1)
}

const managerRoot = join(import.meta.dir, "..")
const src = resolve(arg("src") ?? fail("--src <업스트림 opencode 폴더> 가 필요합니다"))
const target = arg("target") ?? "windows-x64"
const outDir = resolve(managerRoot, arg("out") ?? "dist")
const modelsJson = resolve(arg("models-json") ?? join(managerRoot, "build/models-empty.json"))

const TARGETS: Record<string, { os: string; arch: string; avx2?: false }> = {
  "windows-x64": { os: "win32", arch: "x64" },
  "windows-x64-baseline": { os: "win32", arch: "x64", avx2: false },
  "linux-x64": { os: "linux", arch: "x64" },
}
if (!(target in TARGETS)) fail(`알 수 없는 target: ${target} (사용 가능: ${Object.keys(TARGETS).join(", ")})`)

const pkgDir = join(src, "packages/opencode")
const buildScript = join(pkgDir, "script/build.ts")
if (!existsSync(buildScript)) fail(`업스트림 빌드 스크립트를 찾을 수 없습니다: ${buildScript}`)

// 모델 스냅샷이 유효한 JSON인지 확인 (오류 본문이 내장되는 사고 방지)
try {
  JSON.parse(readFileSync(modelsJson, "utf8"))
} catch (e) {
  fail(`모델 스냅샷이 올바른 JSON이 아닙니다 (${modelsJson}): ${(e as Error).message}`)
}

// 타깃 선택 사본 만들기 (업스트림 파일은 수정하지 않는다)
const original = readFileSync(buildScript, "utf8")
const marker = "const targets = singleFlag"
if (!original.includes(marker)) fail("업스트림 build.ts 의 구조가 바뀌어 타깃을 고르는 사본을 만들 수 없습니다. 이 스크립트를 업스트림 버전에 맞게 고쳐야 합니다.")
const patched = original.replace(
  marker,
  `const __want = JSON.parse(process.env.OCX_TARGET ?? "null") as { os: string; arch: string; avx2?: false } | null\nconst targets = __want ? allTargets.filter((t) => t.os === __want.os && t.arch === __want.arch && t.avx2 === __want.avx2 && t.abi === undefined) : singleFlag`,
)
const generated = join(pkgDir, "script/build-ocx.generated.ts")
writeFileSync(generated, patched)

const commit = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || "알 수 없음"
console.log(`업스트림: ${src} (커밋 ${commit})`)
console.log(`타깃: ${target}, 모델 스냅샷: ${modelsJson}`)

const args = ["run", generated, "--skip-embed-web-ui"]
if (flag("skip-install")) args.push("--skip-install")
const r = spawnSync("bun", args, {
  cwd: pkgDir,
  stdio: "inherit",
  env: { ...process.env, MODELS_DEV_API_JSON: modelsJson, OCX_TARGET: JSON.stringify(TARGETS[target]) },
})
if (r.status !== 0) fail("opencode 빌드에 실패했습니다. 폐쇄망이면 대상 플랫폼용 네이티브 패키지(@opentui/core-*, @ff-labs/fff-bin-*, @parcel/watcher)를 미리 설치한 뒤 --skip-install 로 다시 시도하세요.")

const name = `opencode-${target.replace("windows", "windows").replace("-baseline", "-baseline")}`
const isWin = target.startsWith("windows")
const built = join(pkgDir, "dist", name, "bin", isWin ? "opencode.exe" : "opencode")
if (!existsSync(built)) fail(`빌드 결과를 찾을 수 없습니다: ${built}`)
mkdirSync(outDir, { recursive: true })
const dest = join(outDir, `opencode-${target}${isWin ? ".exe" : ""}`)
copyFileSync(built, dest)
console.log(`빌드 완료: ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)}MB, 업스트림 커밋 ${commit})`)
