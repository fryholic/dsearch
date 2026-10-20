# dsearch

QMD를 검색 엔진으로 사용하는 로컬 문서 검색 프로젝트입니다. CLI·독립 웹 GUI·MCP가 같은 검색 계약을 사용하도록 구성합니다.

현재 저장소에는 **디렉터리 골격, 공통 UI 토큰과 개발 보조 명령**이 있습니다. QMD 통합·실제 검색 API·제품 GUI는 아직 구현하지 않았습니다.

## 시작

Node.js 24.21.0과 pnpm 11.25.0을 사용합니다.

~~~sh
pnpm local:setup
pnpm install --ignore-scripts
pnpm check
~~~

## 구조

- apps/daemon: 로컬 HTTP 서비스와 프로세스 조정
- apps/cli: dsearch 명령
- apps/web: 독립 GUI
- apps/mcp: stdio 브리지
- apps/obsidian: 후속 Obsidian 플러그인
- packages/: 계약·수집·구간 구성·QMD 어댑터·검색·세대·런타임·UI·평가
- vendor/qmd-upstream.json: 기준 upstream과 통합 상태
- tests/, fixtures/: 계약·통합·수용 시험과 합성 자료를 위한 위치

## 로컬 자료

PRD·HLD·LLD·디자인 가이드·IA·목업은 docs/에 로컬로 보관합니다. pnpm local:setup은 이 자료와 artifacts/, .local/을 해당 checkout의 .git/info/exclude에 추가합니다. GitHub 저장소에는 이 설계 문서를 올리지 않습니다. 제외 설정은 clone에 자동 전달되지 않으므로 새 checkout에서 위 명령을 실행하세요.

로컬 목업 자료가 있는 환경에서는 pnpm mockup으로 볼 수 있습니다. 목업은 합성 자료만 사용하며 검색·모델·원문 파일에 연결하지 않습니다.
