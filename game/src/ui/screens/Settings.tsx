import { useState } from "preact/hooks";
import { store, S } from "../../store";
import { saveGame, slotMeta, deleteSlot, loadGame, downloadSave, readSaveFile } from "../../core/save";
import { migrateSave } from "../../core/game";
import { inbox } from "../../core/news";

export function SettingsScreen() {
  const s = S();
  const [, setV] = useState(0);
  const save = async (n: number) => {
    await saveGame(s, n);
    store.slot = n;
    store.say(`슬롯 ${n}에 저장했습니다`);
    setV((v) => v + 1);
  };
  const load = async (n: number) => {
    const g = await loadGame(n);
    if (!g) return;
    for (const note of migrateSave(g, store.data!)) inbox(g, note);
    store.s = g;
    store.slot = n;
    store.go("home");
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <h1>저장 · 설정</h1>
      <div class="frame pad">
        <h2>저장 슬롯</h2>
        <div class="muted" style={{ marginBottom: 6 }}>진행할 때마다 현재 슬롯({store.slot})에 자동 저장됩니다. 브라우저 IndexedDB에 압축해서 넣습니다.</div>
        <table class="t">
          <tbody>
            {[1, 2, 3].map((n) => {
              const m = slotMeta(n);
              return (
                <tr>
                  <td>슬롯 {n}{store.slot === n && <span class="tag gold">현재</span>}</td>
                  <td>{m ? m.label : <span class="dim">비어 있음</span>}</td>
                  <td class="right">
                    <button class="btn small" onClick={() => save(n)}>여기에 저장</button>
                    {m && <button class="btn small" onClick={() => load(n)}>불러오기</button>}
                    {m && n !== store.slot && <button class="btn small danger" onClick={async () => { await deleteSlot(n); setV((v) => v + 1); }}>삭제</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div class="frame pad">
        <h2>세이브 파일</h2>
        <div class="muted" style={{ marginBottom: 6 }}>
          저장 슬롯은 이 브라우저, 이 주소 안에만 있습니다. 다른 기기나 브라우저로 옮기거나 http에서 https 주소로 넘어갈 때는 파일로 내보냈다가 그쪽에서 엽니다.
        </div>
        <div class="row">
          <button class="btn primary" onClick={() => downloadSave(s)}>세이브 파일로 내보내기</button>
          <label class="row" style={{ cursor: "pointer" }}>
            <span class="btn">파일에서 불러와 슬롯 {store.slot}에 덮어쓰기</span>
            <input type="file" accept=".lckm,text/plain" style={{ display: "none" }} onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              const r = await readSaveFile(f);
              if ("error" in r) return store.say(r.error);
              if (!confirm(`슬롯 ${store.slot}의 지금 진행을 이 파일로 바꿉니다. 되돌릴 수 없습니다.`)) return;
              for (const note of migrateSave(r.s, store.data!)) inbox(r.s, note);
              await saveGame(r.s, store.slot);
              store.s = r.s;
              store.go("home");
            }} />
          </label>
        </div>
      </div>
      <div class="frame pad">
        <h2>새 게임</h2>
        <button class="btn danger" onClick={() => { store.s = null; store.bump(); }}>시작 화면으로</button>
        <span class="muted"> 현재 진행은 자동 저장된 상태로 남습니다.</span>
      </div>
      <div class="frame pad dim" style={{ fontSize: 11 }}>
        비공식 팬 게임. League of Legends와 관련 자산은 Riot Games의 것이며, 이 게임은 Riot Games가 보증하거나 후원하지 않습니다. 선수·감독 이름과 기록은 Leaguepedia의 공개 자료에서 가져왔습니다. 뉴스·이적 루머·사건사고는 게임이 지어낸 가상이며, 부정행위·논란 사건은 게임이 만든 가상 신인 선수에게만 일어납니다.
      </div>
    </div>
  );
}
