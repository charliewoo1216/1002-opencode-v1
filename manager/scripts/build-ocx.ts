// ocx 실행 파일 빌드 (Bun 단일 실행 파일)
// 사용: bun run scripts/build-ocx.ts [--target windows-x64-baseline(기본)|windows-x64|linux-x64|native] [--out dist]
// 기본은 AVX2 가 없는 CPU(가상머신, 구형 PC)에서도 도는 baseline 빌드다. 표준 빌드는 AVX2 가 없으면 아무 메시지 없이 죽을 수 있다.
import { spawnSync } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"
import { join } from "node:path"

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? def) : def
}
const target = arg("target", "windows-x64-baseline")
const outDir = join(import.meta.dir, "..", arg("out", "dist"))
const root = join(import.meta.dir, "..")

const BUN_TARGET: Record<string, string | undefined> = {
  "windows-x64": "bun-windows-x64",
  "windows-x64-baseline": "bun-windows-x64-baseline", // AVX2가 없는 구형 CPU용
  "linux-x64": "bun-linux-x64",
  native: undefined,
}
if (!(target in BUN_TARGET)) {
  console.error(`알 수 없는 target: ${target} (사용 가능: ${Object.keys(BUN_TARGET).join(", ")})`)
  process.exit(2)
}

// 1) 내장 프로필 갱신
const gen = spawnSync("bun", ["run", join(root, "scripts/gen-embedded.ts")], { stdio: "inherit" })
if (gen.status !== 0) process.exit(gen.status ?? 1)

// 2) 컴파일
mkdirSync(outDir, { recursive: true })
const isWin = target.startsWith("windows")
const outfile = join(outDir, `ocx-${target}${isWin ? ".exe" : ""}`)
const args = ["build", "--compile", join(root, "src/main.ts"), "--outfile", outfile, "--minify"]
const t = BUN_TARGET[target]
if (t) args.push(`--target=${t}`)
const r = spawnSync("bun", args, { stdio: "inherit", cwd: root })
if (r.status !== 0) {
  console.error("ocx 빌드에 실패했습니다.")
  process.exit(r.status ?? 1)
}
console.log(`빌드 완료: ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)}MB)`)
