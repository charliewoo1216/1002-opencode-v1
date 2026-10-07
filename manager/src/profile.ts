// 프로필: 작업 성격(java/python/ai/분석)별 지침, 검증 명령, 계획서 규칙 묶음
// 프로필 폴더 구조:
//   <profilesDir>/<이름>/profile.json      메타 정보와 검증 명령
//   <profilesDir>/<이름>/AGENTS.md         스택 지침 (매 세션에 주입)
//   <profilesDir>/<이름>/planning.md       계획서 작성 규칙
//   <profilesDir>/<이름>/docs/*.md         사용자가 정리해 넣는 최신 기법·API 요약 (매 세션에 주입)
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { EMBEDDED_PROFILES } from "./embedded-profiles.generated"

export interface ProfileMeta {
  name: string
  description: string
  /** 기본 검증 명령 (작업 계획서에 명령이 없을 때 참고용으로 제시) */
  verify: { build?: string; test?: string; lint?: string; typecheck?: string }
  /** 작업 유형별 시간 한도(분). 예: Java 빌드는 크게 */
  taskTimeoutMinutes?: number
}

export interface Profile extends ProfileMeta {
  dir: string
  /** 세션마다 주입할 지침 파일(절대 경로) */
  instructions: string[]
  /** 계획서 작성 규칙 본문 */
  planningRules: string
}

export class ProfileError extends Error {}

/**
 * 내장 프로필 폴더.
 * 소스로 실행하면 저장소의 profiles/ 를 그대로 쓰고, 컴파일된 exe처럼 그 폴더가 없으면
 * exe에 포함된 내용을 사용자 캐시 폴더에 풀어서 쓴다 (원본 opencode에 파일 경로로 넘겨야 하기 때문).
 * OCX_FORCE_EMBEDDED=1 이면 항상 후자를 쓴다 (테스트용).
 */
export function builtinProfilesDir(): string {
  const disk = resolve(dirname(fileURLToPath(import.meta.url)), "..", "profiles")
  if (existsSync(disk) && !process.env.OCX_FORCE_EMBEDDED) return disk
  return extractEmbeddedProfiles()
}

/** 내장 프로필을 캐시 폴더에 풀고 그 경로를 돌려준다. 내용이 같으면 다시 쓰지 않는다 */
export function extractEmbeddedProfiles(base?: string): string {
  const hash = createHash("sha1").update(JSON.stringify(EMBEDDED_PROFILES)).digest("hex").slice(0, 10)
  const root = base ?? process.env.OCX_HOME ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ocx") : join(tmpdir(), "ocx"))
  const dir = join(root, `builtin-profiles-${hash}`)
  const marker = join(dir, ".complete")
  if (!existsSync(marker)) {
    for (const [rel, content] of Object.entries(EMBEDDED_PROFILES)) {
      const dest = join(dir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, content)
    }
    writeFileSync(marker, hash)
  }
  return dir
}

function searchDirs(profilesDir?: string): string[] {
  return [...(profilesDir ? [resolve(profilesDir)] : []), builtinProfilesDir()]
}

export function listProfiles(profilesDir?: string): string[] {
  const names = new Set<string>()
  for (const d of searchDirs(profilesDir)) {
    if (!existsSync(d)) continue
    for (const n of readdirSync(d)) {
      if (existsSync(join(d, n, "profile.json"))) names.add(n)
    }
  }
  return [...names].sort()
}

/** 사용자 정의 프로필이 같은 이름의 내장 프로필보다 우선한다 */
export function loadProfile(name: string, profilesDir?: string): Profile {
  for (const d of searchDirs(profilesDir)) {
    const dir = join(d, name)
    const metaFile = join(dir, "profile.json")
    if (!existsSync(metaFile)) continue
    let meta: ProfileMeta
    try {
      meta = JSON.parse(readFileSync(metaFile, "utf8"))
    } catch (e) {
      throw new ProfileError(`프로필 "${name}"의 profile.json이 올바른 JSON이 아닙니다: ${(e as Error).message}`)
    }
    if (!meta.name || !meta.description) throw new ProfileError(`프로필 "${name}"의 profile.json에 name, description이 필요합니다.`)
    const instructions: string[] = []
    const agentsMd = join(dir, "AGENTS.md")
    if (existsSync(agentsMd)) instructions.push(agentsMd)
    const docsDir = join(dir, "docs")
    if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
      for (const f of readdirSync(docsDir).sort()) if (f.endsWith(".md")) instructions.push(join(docsDir, f))
    }
    const planning = join(dir, "planning.md")
    return {
      ...meta,
      verify: meta.verify ?? {},
      dir,
      instructions,
      planningRules: existsSync(planning) ? readFileSync(planning, "utf8") : "",
    }
  }
  throw new ProfileError(`프로필 "${name}"을(를) 찾을 수 없습니다. 사용 가능: ${listProfiles(profilesDir).join(", ") || "(없음)"}`)
}
