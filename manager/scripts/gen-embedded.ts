// 내장 프로필을 TypeScript 모듈로 생성한다 (컴파일된 exe 안에서는 profiles/ 폴더를 읽을 수 없으므로 내용을 포함시킨다)
// 사용: bun run scripts/gen-embedded.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = join(import.meta.dir, "..")
const profiles = join(root, "profiles")

export function collect(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) Object.assign(out, collect(full, base))
    else out[relative(base, full).split("\\").join("/")] = readFileSync(full, "utf8")
  }
  return out
}

export function render(files: Record<string, string>): string {
  return `// 자동 생성 파일입니다. 직접 고치지 마세요. (bun run scripts/gen-embedded.ts)
// manager/profiles/ 의 내용을 컴파일된 exe에 포함시키기 위한 것입니다.
export const EMBEDDED_PROFILES: Record<string, string> = ${JSON.stringify(files, null, 2)}
`
}

if (import.meta.main) {
  const files = collect(profiles)
  writeFileSync(join(root, "src/embedded-profiles.generated.ts"), render(files))
  console.log(`내장 프로필 ${Object.keys(files).length}개 파일을 생성했습니다.`)
}
