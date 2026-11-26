import { useState } from "preact/hooks";
import { S } from "../../store";
import type { CompId, Trophy } from "../../core/types";
import { COMP_NAME } from "../../core/types";
import { fmtDate } from "../../core/format";
import { ROLE_KO } from "../../data/types";
import { Modal, TeamLogo, TrophyArt } from "../components";

const ORDER: CompId[] = ["WORLDS", "MSI", "PO", "CUP", "REG"];

export function TrophyScreen() {
  const s = S();
  const me = s.teams[s.user];
  const [sel, setSel] = useState<Trophy | null>(null);
  const mine = [...s.trophies].sort((a, b) => ORDER.indexOf(a.comp) - ORDER.indexOf(b.comp) || b.season - a.season);
  const slots = Math.max(10, Math.ceil((mine.length + 2) / 5) * 5);
  return (
    <div>
      <h1>트로피 진열장</h1>
      <div class="row" style={{ marginBottom: 8 }}>
        <TeamLogo id={s.user} size={30} />
        <span>{me.name} · 게임 속 우승 {mine.filter((t) => t.comp !== "REG").length}회</span>
        <span class="muted">구단 역대 기록(실제 + 게임): LCK {me.titles.lck} · MSI {me.titles.msi} · 월즈 {me.titles.worlds} · LCK 컵 {me.titles.cup}</span>
      </div>
      <div class="frame" style={{ padding: 0 }}>
        <div class="shelf">
          {Array.from({ length: slots }, (_, i) => {
            const t = mine[i];
            return (
              <div class="slotT" onClick={() => t && setSel(t)}>
                {t ? (
                  <>
                    <TrophyArt comp={t.comp} scale={t.comp === "WORLDS" ? 8 : t.comp === "REG" ? 5 : 7} />
                    <div class="lbl">{t.name}</div>
                  </>
                ) : <TrophyArt comp="CUP" scale={6} dim />}
              </div>
            );
          })}
        </div>
      </div>
      <div class="muted" style={{ fontSize: 11 }}>우승하면 여기에 트로피가 놓입니다. 누르면 그 시즌 우승 멤버를 볼 수 있습니다.</div>
      {sel && (
        <Modal onClose={() => setSel(null)}>
          <div class="row" style={{ gap: 20 }}>
            <TrophyArt comp={sel.comp} scale={12} />
            <div>
              <h1>{sel.name}</h1>
              <div class="muted">{COMP_NAME[sel.comp]} · {fmtDate(sel.day)}</div>
              {sel.final && <div class="gold">결승 {sel.final}</div>}
              <div class="sp" />
              {sel.roster.map((r) => <div>{ROLE_KO[r.role]} <b>{r.name}</b></div>)}
              {sel.coach && <div class="muted">감독 {sel.coach}</div>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
