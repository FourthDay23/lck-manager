import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { fmtDate } from "../../core/format";
import type { NewsItem } from "../../core/types";
import { TeamLogo } from "../components";

const FILTERS: [string, string, (n: NewsItem) => boolean][] = [
  ["all", "전체", () => true],
  ["mine", "우리 팀", (n) => !!n.mine],
  ["move", "이적 · 계약", (n) => ["sign", "release", "trade", "renew"].includes(n.kind)],
  ["result", "경기", (n) => n.kind === "result" || n.kind === "title"],
  ["incident", "사건 · 징계", (n) => n.kind === "tamper" || n.kind === "scandal" || n.kind === "money"],
];

export function NewsScreen() {
  const s = S();
  const [f, setF] = useState("all");
  const fn = FILTERS.find((x) => x[0] === f)![2];
  for (const m of s.inbox) m.read = true;
  return (
    <div>
      <h1>뉴스</h1>
      <div class="grid2" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <div class="frame pad">
          <div class="tabs">{FILTERS.map(([k, l]) => <button class={`btn small ${f === k ? "on" : ""}`} onClick={() => setF(k)}>{l}</button>)}</div>
          {s.news.filter(fn).slice(0, 150).map((n) => (
            <div class={`news-item ${n.mine ? "mine" : ""}`}>
              <div class="row" style={{ gap: 6 }}>
                <span class="dim" style={{ fontSize: 11 }}>{fmtDate(n.day, false)}</span>
                {n.teams?.slice(0, 2).map((t) => <TeamLogo id={t} size={16} />)}
                {n.kind === "tamper" && <span class="tag red">징계</span>}
                {n.kind === "scandal" && <span class="tag red">논란</span>}
                {n.kind === "title" && <span class="tag gold">우승</span>}
                <span class="t">{n.title}</span>
              </div>
              {n.body && <div class="muted" style={{ fontSize: 12 }}>{n.body}</div>}
              {n.players?.length ? <div style={{ fontSize: 11 }}>{n.players.slice(0, 4).map((p) => <a href="#" onClick={(e) => { e.preventDefault(); store.open("player", p); }}>{s.players[p]?.name} </a>)}</div> : null}
            </div>
          ))}
          <div class="dim" style={{ fontSize: 11, marginTop: 6 }}>뉴스와 사건은 게임 속 가상입니다. 논란·부정행위 사건은 게임이 만든 가상 신인에게만 일어납니다.</div>
        </div>
        <div class="frame pad">
          <h2>받은 메시지</h2>
          {s.inbox.slice(0, 60).map((m) => <div style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid #222739" }}><span class="dim">{fmtDate(m.day, false)}</span> {m.text}</div>)}
        </div>
      </div>
    </div>
  );
}
