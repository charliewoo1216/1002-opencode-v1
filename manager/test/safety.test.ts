import { describe, expect, test } from "bun:test"
import { bashPermissionRules, commandWords, guardCommand, safetyPermission, splitSegments } from "../src/safety"

describe("명령 분해", () => {
  test("복합 명령을 나누고 환경변수·래퍼를 건너뛴다", () => {
    expect(splitSegments("cd app && mvn test | tee out.txt; echo $(git status)")).toEqual(["cd app", "mvn test", "tee out.txt", "echo", "git status"])
    expect(commandWords("FOO=1 BAR=2 env nohup git status")).toEqual(["git", "status"])
    expect(commandWords('"git" log')).toEqual(["git", "log"])
  })
})

describe("명령 검사", () => {
  const blocked = (c: string) => expect(guardCommand(c)).not.toBeNull()
  const allowed = (c: string) => expect(guardCommand(c)).toBeNull()

  test("Git은 어떤 형태로든 막는다", () => {
    for (const c of ["git status", "git commit -m x", "cd x && git push", "echo hi | git apply", "FOO=1 git log", "/usr/bin/git diff", "git.exe pull", "(git add .)", "echo $(git rev-parse HEAD)", "sh -c 'ls' ; git stash"]) blocked(c)
    expect(guardCommand("git status")).toContain("Git")
  })

  test("Git과 비슷한 이름이나 문자열은 막지 않는다", () => {
    for (const c of ["echo digit", "ls legit", "gitlab-runner --version".replace("gitlab-runner", "echo"), "cat .gitignore", "mvn test"]) allowed(c)
  })

  test("위험한 삭제·권한 상승·시스템 명령을 막는다", () => {
    for (const c of ["rm -rf /", "rm -rf ~", "rm -rf .", "rm -fr ..", "rm -rf /usr/lib", "sudo apt install x", "shutdown -h now", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "chmod -R 777 /"]) blocked(c)
  })

  test("프로젝트 안의 일반 삭제는 허용한다", () => {
    for (const c of ["rm -rf build", "rm -rf target/classes", "rm file.txt", "rm -rf node_modules"]) allowed(c)
  })

  test("외부 네트워크·배포 명령은 막고, 같은 PC 서버 호출은 허용한다", () => {
    for (const c of ["curl https://example.com", "wget http://10.0.0.5/x", "ssh host", "npm publish", "twine upload dist/*", "docker push img", "mvn deploy"]) blocked(c)
    for (const c of ["curl http://localhost:8080/health", "curl -s http://127.0.0.1:3000/tools", "curl localhost:9000"]) allowed(c)
  })

  test("설정으로 금지 명령을 추가할 수 있다", () => {
    expect(guardCommand("python script.py", { extraBlocked: ["python"] })).toContain("설정에서 금지")
    expect(guardCommand("pytest")).toBeNull()
  })
})

describe("원본 권한 규칙", () => {
  test("bash 규칙에 Git과 위험 명령 거부가 들어간다", () => {
    const r = bashPermissionRules()
    expect(r["*"]).toBe("allow")
    expect(r["git *"]).toBe("deny")
    expect(r["git"]).toBe("deny")
    expect(r["sudo *"]).toBe("deny")
    expect(r["curl *"]).toBe("deny")
    expect(r["curl *localhost*"]).toBe("allow")
    expect(Object.keys(r).indexOf("curl *localhost*")).toBeGreaterThan(Object.keys(r).indexOf("curl *")) // 허용 예외가 뒤에 와야 우선한다
  })

  test("환경변수 접두·래퍼·셸 경유 형태도 막는다 (원본에서 FOO=1 git ...이 통과하는 것을 실측으로 확인해 추가)", () => {
    const r = bashPermissionRules()
    for (const k of ["*=* git", "*=* git *", "env git *", "nohup git *", "sh -c *git *", "bash -c *git *", "*=* sudo *"]) expect(r[k]).toBe("deny")
  })

  test("전체 권한 설정에 웹 도구 차단이 포함된다", () => {
    const p = safetyPermission() as any
    expect(p.webfetch).toBe("deny")
    expect(p.websearch).toBe("deny")
    expect(p.bash["git *"]).toBe("deny")
    expect(p.external_directory).toBe("deny") // 무인 실행은 작업 폴더 밖 접근을 막는다
    expect((safetyPermission({ interactive: true }) as any).external_directory).toBeUndefined() // 대화형은 원본 기본값(확인)
  })
})
