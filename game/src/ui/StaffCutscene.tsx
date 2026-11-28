// The cutscene for a head coach or coach hired through talks (core/staffNeg.ts completeStaffHire), in the form of
// a player's WELCOME. Overlays.tsx CutsceneLayer draws the stage (stripes, confetti, click to go on) around it.
import { S } from "../store";
import type { Cutscene } from "../core/types";
import { STAFF_ROLE_KO } from "../core/staffNeg";
import { TeamLogo } from "./components";
import { StaffAvatar } from "./StaffAvatar";
import "./staff-cutscene.css";

export function StaffCutsceneBody({ c, c1 }: { c: Cutscene; c1: string }) {
  const s = S();
  const st = c.staff ? s.staff[c.staff] : null;
  const t = c.team ? s.teams[c.team] : s.teams[s.user];
  // the title starts with the role he was hired as (core/staffNeg.ts completeStaffHire)
  const head = st ? st.role === "Head Coach" : c.title.startsWith("감독");
  return (
    <>
      <div class="row" style={{ justifyContent: "center" }}><TeamLogo id={t.id} size={44} /><span class="muted" style={{ fontSize: 14 }}>OFFICIAL</span></div>
      <div class="big" style={{ color: c1 }}>WELCOME</div>
      <div class={`staff-cut-role ${head ? "head" : ""}`}>{head ? "HEAD COACH" : "COACH"}</div>
      {st && (
        <div class="pcard frame" style={{ boxShadow: `0 0 0 2px ${c1}, 0 0 0 4px #000` }}>
          <StaffAvatar sid={st.id} size={120} />
          <div style={{ fontFamily: "Galmuri14", fontSize: 22 }}>{st.name}</div>
          <div class="muted">{st.realName}</div>
          <div><span class={`tag ${head ? "gold" : ""}`}>{STAFF_ROLE_KO[st.role]}</span> <span class="muted" style={{ fontSize: 12 }}>명성 {st.fame}{st.titles ? ` · 우승 ${st.titles}` : ""}</span></div>
          <div class="muted staff-cut-attrs">밴픽 {st.attrs.draft} · 육성 {st.attrs.develop}<br />동기부여 {st.attrs.motivate} · 분석 {st.attrs.analysis}</div>
        </div>
      )}
      <div class="sub">{c.title}</div>
      <div class="sub">{c.sub}</div>
    </>
  );
}
