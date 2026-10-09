#!/usr/bin/env bun
// ocx 진입점. 컴파일된 exe 가 시작하면 항상 이 파일이 실행된다.
// (예전에는 cli.ts 안에서 "내가 진입 파일인가"를 경로 비교로 판단했는데, 경로 표기가 다르면 아무것도 실행하지 않고
//  조용히 종료할 수 있어 Windows 에서 위험하므로, 진입 파일을 따로 두고 조건 없이 실행한다.)
import { main } from "./cli"

process.exit(await main(process.argv.slice(2)))
