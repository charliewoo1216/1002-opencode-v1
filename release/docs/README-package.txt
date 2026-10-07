ocx 사용 시작하기
==================

1. ocx.config.example.json 을 ocx.config.json 으로 복사한 뒤, models 의 baseURL / model 을 사내 LLM 서버에 맞게 고칩니다.
2. 점검:   ocx.exe config check --online
3. 도움말: ocx.exe --help      (명령별: ocx.exe <명령> --help,  가이드: ocx.exe guide)
4. 계획서: ocx.exe plan --profile python "<몇 줄의 지시>"
5. 퇴근 전: ocx.exe night       아침에: ocx.exe report

이 폴더의 opencode.exe 는 ocx가 내부에서 사용하는 원본 OpenCode(폐쇄망 설정으로 빌드됨)입니다.
ocx 실행 파일과 opencode.exe 를 같은 폴더에 두거나, ocx.config.json 의 opencode.command 에 경로를 적으세요.

Windows Terminal에서 실행하는 것을 권장합니다. 서명되지 않은 실행 파일이라 SmartScreen/백신 경고가 나올 수 있습니다.

Git 명령은 ocx가 실행하지 않습니다. 커밋은 직접 하세요.
