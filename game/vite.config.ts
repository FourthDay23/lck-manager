import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import preact from "@preact/preset-vite";

// 작업 워크트리(.claude/worktrees/*)에는 node_modules가 없고, 워크트리들의 부모 폴더에 메인 폴더
// game/node_modules로 가는 연결(junction)이 하나 있다(lolsim_orch.py setup). Node처럼 위로 올라가며 찾은
// node_modules가 이 폴더 것이 아니면, 그 실제 경로를 서빙 허용 목록에 넣고(안 넣으면 글꼴 등이 403)
// 의존성 캐시를 폴더마다 따로 둔다(같이 쓰면 dev 서버끼리 번갈아 캐시를 다시 만든다).
// 메인 폴더에서는 아무것도 바뀌지 않는다.
const here = fileURLToPath(new URL(".", import.meta.url));
const local = resolve(here, "node_modules");
function nearestModules(dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, "node_modules");
    if (existsSync(join(candidate, "vite"))) return realpathSync(candidate);
    if (dirname(d) === d) return local;
  }
}
const modules = nearestModules(here);
const linked = modules.toLowerCase() !== local.toLowerCase();

export default defineConfig({
  base: "./",
  plugins: [preact()],
  // CSS가 글꼴을 "../node_modules/galmuri/..."처럼 상대 경로로 가리키므로, 연결일 때는 그 경로를 실제 위치로 돌린다.
  ...(linked
    ? {
        cacheDir: resolve(here, ".vite"),
        resolve: { alias: [{ find: /^(?:\.\.\/)+node_modules\//, replacement: modules.replace(/\\/g, "/") + "/" }] },
      }
    : {}),
  server: {
    port: 5310,
    strictPort: true,
    ...(linked ? { fs: { allow: [searchForWorkspaceRoot(here), modules] } } : {}),
  },
});
