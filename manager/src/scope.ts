// 계획서 범위 판정: 작업의 대상 파일 기준으로 "범위 안"인 변경인지 가른다
//  - 대상 파일 자체
//  - 대상이 폴더를 가리키는 경우 그 아래 파일
//  - 대상 파일과 같은 폴더의 파일 (새 클래스·테스트 파일을 옆에 만드는 경우를 허용)

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")

export function inScope(path: string, targets: string[]): boolean {
  const f = norm(path)
  for (const raw of targets) {
    const t = norm(raw)
    if (!t) continue
    if (f === t) return true
    if (f.startsWith(t + "/")) return true
    const dir = t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : ""
    const fdir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""
    if (dir === fdir && /\.[A-Za-z0-9]+$/.test(t)) return true // 같은 폴더(대상이 파일인 경우만)
  }
  return false
}

export function outOfScope(changed: string[], targets: string[]): string[] {
  // 대상 파일이 하나도 지정되지 않은 작업은 범위를 판단할 수 없으므로 표시하지 않는다
  if (targets.length === 0) return []
  return changed.filter((p) => !inScope(p, targets))
}
