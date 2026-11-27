#!/bin/sh
# 커밋된 내용만 꺼낸 깨끗한 사본에서 빌드해 lck-manager.kro.kr에 올린다(CLAUDE.md 5절).
# 작업 폴더에 남은 다른 세션의 미커밋 변경이 사이트로 새지 않게 하려는 것이다. 어느 폴더에서 실행해도 된다.
#   sh game/deploy/release.sh                    main을 배포
#   sh game/deploy/release.sh <ref>              다른 커밋·브랜치를 배포
#   sh game/deploy/release.sh main --build-only  빌드만 해 보고 올리지 않음
set -e
REF=${1:-main}
MODE=${2:-}
# ref는 실행한 폴더 기준으로 한 번만 풀어 커밋으로 고정한다(워크트리의 HEAD가 메인 폴더 HEAD로 바뀌거나,
# 그 사이 main에 새 커밋이 들어와 기록과 배포본이 달라지지 않게).
FULL=$(git rev-parse --verify "$REF^{commit}")
SHA=$(git rev-parse --short "$FULL")
ROOT=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/lck-release.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

echo "release: $REF ($SHA) -> $TMP"
git -C "$ROOT" archive "$FULL" game | tar -x -C "$TMP"
cd "$TMP/game"
npm ci --prefer-offline --no-audit --no-fund
VERSION=$(sed -n 's/^ *version: "\([^"]*\)".*/\1/p' src/ui/info/patchnotes.ts 2>/dev/null | head -1)

if [ "$MODE" = "--build-only" ]; then
  npm run build
  echo "build-only OK: $SHA v${VERSION:-?} (배포 안 함)"
  exit 0
fi

if [ -z "$VERSION" ]; then
  echo "패치노트 버전을 읽지 못했다(game/src/ui/info/patchnotes.ts). 패치노트를 먼저 쓰고 다시 실행." >&2
  exit 1
fi
sh deploy/deploy.sh
ORCH="$HOME/.claude/hooks/lolsim_orch.py"
if [ -f "$ORCH" ]; then python -X utf8 "$ORCH" released "$SHA" "$VERSION" || true; fi
echo "released: $SHA v$VERSION"
