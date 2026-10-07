// 외부 호출 기록용 싱크 프록시 (검증 도구)
// 대상 프로그램의 HTTP(S)_PROXY 를 이 서버로 지정하면, 외부로 나가려는 모든 연결의
// 첫 줄(CONNECT 호스트 또는 GET URL)을 기록하고 연결을 거부한다.
// 사용: bun run test/net-sink.ts <포트> <기록파일>

import { appendFileSync, writeFileSync } from "node:fs"

export function startNetSink(port: number, logFile: string) {
  writeFileSync(logFile, "")
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(socket, data) {
        const first = Buffer.from(data).toString("utf8").split("\r\n")[0] ?? ""
        appendFileSync(logFile, first + "\n")
        socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        socket.end()
      },
      open() {},
      close() {},
      error() {},
    },
  })
  return { stop: () => server.stop(true) }
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 19999)
  const logFile = process.argv[3] ?? "net-sink.log"
  startNetSink(port, logFile)
  console.log(`싱크 프록시 시작: 127.0.0.1:${port} -> ${logFile}`)
}
