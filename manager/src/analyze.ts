// 참조 자료 분석 (F2)
// 1) 대상 파일 목록을 스크립트로 추출한다 (모델이 빠뜨리지 않게)
// 2) 크기 기준으로 분석 단위(unit)로 나눈다 — 컨텍스트가 넘치지 않게
// 3) 단위마다 읽기 전용 에이전트로 분석해 노트(MD)를 저장한다
// 4) 색인(index.json)에 파일 해시를 남겨, 바뀌지 않은 단위는 다시 분석하지 않고 끊겨도 이어서 한다
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { AGENT_ANALYZE, ANALYZE_REQUIRED_HEADINGS } from "./agents"
import type { OcxConfig } from "./config"
import type { Logger } from "./logger"
import type { Layout } from "./paths"
import type { RunResult } from "./runner"

/** 분석 대상에서 제외할 폴더 */
const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "__pycache__", ".venv", "venv", ".idea", ".gradle", ".batch", ".plan", ".notes"])
/** 분석 대상 확장자 (텍스트로 읽을 수 있는 소스·문서) */
const TEXT_EXTS = new Set([
  ".java", ".kt", ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".c", ".h", ".cpp", ".cs", ".sql", ".xml", ".yml", ".yaml",
  ".json", ".toml", ".properties", ".gradle", ".md", ".txt", ".sh", ".html", ".css", ".ipynb",
])
const MAX_FILE_BYTES = 200_000

export interface SourceFile {
  /** 참조 폴더 기준 상대 경로 (항상 / 구분자) */
  path: string
  bytes: number
  hash: string
}

export interface AnalysisUnit {
  /** 단위 이름 (노트 파일 이름으로도 쓰임) */
  id: string
  files: SourceFile[]
  /** 단위를 이루는 파일들의 해시를 합친 값 — 바뀌었는지 판단 */
  hash: string
}

export interface IndexEntry {
  id: string
  hash: string
  files: string[]
  status: "done" | "failed"
  noteFile: string
  summary: string
  analyzedAt: string
}

export interface NotesIndex {
  version: 1
  referenceDir: string
  units: Record<string, IndexEntry>
}

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex")
}

const toPosix = (p: string) => p.split(sep).join("/")

/** 참조 폴더의 분석 대상 파일 목록 (정렬되어 항상 같은 결과) */
export function scanSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full)
      } else if (st.isFile()) {
        const dot = name.lastIndexOf(".")
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ""
        if (!TEXT_EXTS.has(ext) || st.size === 0 || st.size > MAX_FILE_BYTES) continue
        out.push({ path: toPosix(relative(root, full)), bytes: st.size, hash: sha1(readFileSync(full)) })
      }
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/**
 * 파일들을 분석 단위로 묶는다.
 * 같은 최상위 폴더(없으면 루트)끼리 모으고, 단위당 크기 상한을 넘으면 순서대로 쪼갠다.
 */
export function splitIntoUnits(files: SourceFile[], maxBytesPerUnit: number): AnalysisUnit[] {
  const groups = new Map<string, SourceFile[]>()
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.split("/")[0]! : "(루트)"
    const list = groups.get(top) ?? []
    list.push(f)
    groups.set(top, list)
  }
  const units: AnalysisUnit[] = []
  const safe = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || "root"
  for (const [top, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let current: SourceFile[] = []
    let size = 0
    let part = 1
    const flush = () => {
      if (current.length === 0) return
      const id = `${safe(top)}${part > 1 || list.length > current.length ? `-${part}` : ""}`
      units.push({ id, files: current, hash: sha1(current.map((f) => `${f.path}:${f.hash}`).join("\n")) })
      current = []
      size = 0
      part++
    }
    for (const f of list) {
      if (size + f.bytes > maxBytesPerUnit && current.length > 0) flush()
      current.push(f)
      size += f.bytes
    }
    flush()
  }
  // 이름 중복 방지 (드물지만 폴더 이름이 정규화 후 같아지는 경우)
  const seen = new Map<string, number>()
  for (const u of units) {
    const n = (seen.get(u.id) ?? 0) + 1
    seen.set(u.id, n)
    if (n > 1) u.id = `${u.id}-${n}`
  }
  return units
}

/** 모델 컨텍스트에서 분석 단위 크기 상한(바이트)을 추정한다. 대략 컨텍스트의 35%를 파일 내용에 쓴다 */
export function maxBytesForContext(contextTokens: number): number {
  // 한글·코드 혼합에서 토큰당 약 3바이트로 보수적으로 가정
  return Math.max(8_000, Math.floor(contextTokens * 0.35 * 3))
}

export function notesDir(layout: Layout) {
  return layout.notes
}
const indexPath = (layout: Layout) => join(layout.notes, "index.json")

export function readIndex(layout: Layout): NotesIndex | null {
  const p = indexPath(layout)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function writeIndex(layout: Layout, idx: NotesIndex) {
  mkdirSync(layout.notes, { recursive: true })
  writeFileSync(indexPath(layout), JSON.stringify(idx, null, 2))
}

export function unitPrompt(unit: AnalysisUnit, referenceDir: string): string {
  const list = unit.files.map((f) => `- \`${referenceDir}/${f.path}\` (${f.bytes}바이트)`).join("\n")
  return `다음 파일들을 모두 읽고 분석해 노트를 작성하세요. 목록의 모든 파일을 다뤄야 합니다.

모듈 이름: ${unit.id}

대상 파일:
${list}

출력 형식은 시스템 지침의 노트 형식을 정확히 따르세요.`
}

/** 노트의 첫 문단이 아니라 "## 요약" 아래 내용을 요약으로 뽑는다 */
export function extractSummary(note: string): string {
  const m = note.match(/##\s*요약\s*\n([\s\S]*?)(?:\n##\s|$)/)
  return (m?.[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 300)
}

export interface AnalyzeOptions {
  cfg: OcxConfig
  layout: Layout
  /** 참조 폴더(절대 경로) */
  referenceRoot: string
  /** 분석에 쓸 모델 이름 */
  model: string
  log: Logger
  /** 에이전트 호출 (테스트에서 대체 가능) */
  runUnit: (unit: AnalysisUnit, prompt: string) => Promise<Pick<RunResult, "text" | "endedBy" | "exitCode">>
  /** 분석 단위 크기 상한(바이트). 생략하면 모델 컨텍스트에서 추정 */
  maxBytesPerUnit?: number
  /** 노트 검증 실패 시 재시도 횟수 */
  retries?: number
}

export interface AnalyzeReport {
  total: number
  analyzed: string[]
  skipped: string[]
  failed: Array<{ id: string; reason: string }>
  removed: string[]
}

/** 노트 형식 검증: 필수 제목이 모두 있는지 */
export function checkNoteFormat(note: string): string[] {
  const problems: string[] = []
  for (const h of ANALYZE_REQUIRED_HEADINGS) {
    if (!new RegExp(`^##\\s*${h}`, "m").test(note)) problems.push(`"## ${h}" 항목이 없습니다`)
  }
  return problems
}

export async function analyzeReference(o: AnalyzeOptions): Promise<AnalyzeReport> {
  const files = scanSourceFiles(o.referenceRoot)
  const maxBytes = o.maxBytesPerUnit ?? maxBytesForContext(o.cfg.models[o.model]!.contextLimit)
  const units = splitIntoUnits(files, maxBytes)
  const prev = readIndex(o.layout)
  const idx: NotesIndex = { version: 1, referenceDir: o.cfg.referenceDir, units: {} }
  const report: AnalyzeReport = { total: units.length, analyzed: [], skipped: [], failed: [], removed: [] }

  mkdirSync(o.layout.notes, { recursive: true })
  for (const u of units) {
    const before = prev?.units[u.id]
    const noteFile = `${u.id}.md`
    // 바뀌지 않았고 이미 성공한 단위는 다시 분석하지 않는다 (이어하기·변경 감지)
    if (before && before.status === "done" && before.hash === u.hash && existsSync(join(o.layout.notes, noteFile))) {
      idx.units[u.id] = before
      report.skipped.push(u.id)
      continue
    }
    let reason = ""
    let note = ""
    const attempts = 1 + (o.retries ?? 1)
    for (let i = 1; i <= attempts; i++) {
      o.log.info(`분석 중: ${u.id} (${u.files.length}개 파일), 시도 ${i}/${attempts}`)
      const res = await o.runUnit(u, unitPrompt(u, o.cfg.referenceDir) + (reason ? `\n\n이전 시도의 문제: ${reason}\n이 문제를 고쳐서 다시 작성하세요.` : ""))
      if (res.endedBy !== "exit" || res.exitCode !== 0) {
        reason = `실행이 정상 종료되지 않았습니다 (${res.endedBy}, 종료코드 ${res.exitCode})`
        continue
      }
      const problems = checkNoteFormat(res.text)
      if (problems.length > 0) {
        reason = problems.join(", ")
        continue
      }
      note = res.text.trim()
      reason = ""
      break
    }
    if (reason || !note) {
      report.failed.push({ id: u.id, reason: reason || "빈 응답" })
      idx.units[u.id] = { id: u.id, hash: u.hash, files: u.files.map((f) => f.path), status: "failed", noteFile, summary: "", analyzedAt: new Date().toISOString() }
    } else {
      writeFileSync(join(o.layout.notes, noteFile), note + "\n")
      idx.units[u.id] = {
        id: u.id,
        hash: u.hash,
        files: u.files.map((f) => f.path),
        status: "done",
        noteFile,
        summary: extractSummary(note),
        analyzedAt: new Date().toISOString(),
      }
      report.analyzed.push(u.id)
    }
    writeIndex(o.layout, idx) // 단위마다 저장해 중간에 죽어도 이어서 할 수 있게 한다
  }
  // 참조에서 사라진 단위는 색인에서 뺀다
  for (const id of Object.keys(prev?.units ?? {})) if (!idx.units[id]) report.removed.push(id)
  writeIndex(o.layout, idx)
  writeFileSync(join(o.layout.notes, "INDEX.md"), renderIndexMd(idx))
  return report
}

/** 사람과 모델이 함께 읽는 색인 문서 */
export function renderIndexMd(idx: NotesIndex): string {
  const lines = ["# 참조 분석 색인", "", "| 모듈 | 상태 | 파일 수 | 요약 |", "|---|---|---|---|"]
  for (const e of Object.values(idx.units)) {
    lines.push(`| [${e.id}](${e.noteFile}) | ${e.status === "done" ? "완료" : "실패"} | ${e.files.length} | ${e.summary.replace(/\|/g, "\\|")} |`)
  }
  return lines.join("\n") + "\n"
}

/** 계획서 작성 때 모델에게 알려줄 색인 요약 */
export function notesOverview(layout: Layout): string {
  const idx = readIndex(layout)
  if (!idx || Object.keys(idx.units).length === 0) return "(분석된 참조 자료가 없습니다)"
  return Object.values(idx.units)
    .filter((e) => e.status === "done")
    .map((e) => `- ${e.id}: ${e.summary} (노트: ${layout.notes}/${e.noteFile})`)
    .join("\n")
}

// ---------- 분석 결과 검증 (F2) ----------

export interface NoteVerification {
  id: string
  /** 노트가 다루지 않은 대상 파일 */
  uncoveredFiles: string[]
  /** 노트에 언급됐지만 실제로 존재하지 않는 경로 */
  missingPaths: string[]
  formatProblems: string[]
  ok: boolean
}

/** 노트 본문에서 백틱으로 감싼 경로 후보를 뽑는다 */
export function extractPathMentions(note: string): string[] {
  const out = new Set<string>()
  for (const m of note.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1]!.trim()
    if (/\s/.test(t)) continue
    // 확장자가 있는 파일 경로 모양만 (예: src/App.java, reference/a/b.py)
    if (/^[\w./\\-]+\.[A-Za-z0-9]{1,6}$/.test(t) && !/^\d+(\.\d+)+$/.test(t)) out.add(t.replace(/\\/g, "/"))
  }
  return [...out]
}

export function verifyNote(
  entry: IndexEntry,
  note: string,
  opts: { workRoot: string; referenceDir: string },
): NoteVerification {
  const uncoveredFiles = entry.files.filter((f) => {
    const base = f.split("/").pop()!
    return !note.includes(f) && !note.includes(base)
  })
  const missingPaths: string[] = []
  for (const p of extractPathMentions(note)) {
    const candidates = [join(opts.workRoot, p), join(opts.workRoot, opts.referenceDir, p)]
    // 파일 이름만 쓴 경우(디렉터리 없음)는 대상 파일 이름과 일치하면 인정
    const bare = !p.includes("/")
    const known = bare && entry.files.some((f) => f.split("/").pop() === p)
    if (!known && !candidates.some((c) => existsSync(c))) missingPaths.push(p)
  }
  const formatProblems = checkNoteFormat(note)
  return {
    id: entry.id,
    uncoveredFiles,
    missingPaths,
    formatProblems,
    ok: uncoveredFiles.length === 0 && missingPaths.length === 0 && formatProblems.length === 0,
  }
}

/** 색인의 모든 완료 노트를 검증한다 */
export function verifyAllNotes(layout: Layout, opts: { workRoot: string; referenceDir: string }): NoteVerification[] {
  const idx = readIndex(layout)
  if (!idx) return []
  const results: NoteVerification[] = []
  for (const e of Object.values(idx.units)) {
    if (e.status !== "done") continue
    const file = join(layout.notes, e.noteFile)
    if (!existsSync(file)) {
      results.push({ id: e.id, uncoveredFiles: e.files, missingPaths: [], formatProblems: ["노트 파일이 없습니다"], ok: false })
      continue
    }
    results.push(verifyNote(e, readFileSync(file, "utf8"), opts))
  }
  return results
}
