// A player's two summoner spells in the match HUD, the way a broadcast shows them: the icon, greyed out with the
// seconds left while it is on cooldown. The pair is the one that champion takes in that role in the LCK
// (match/summoners.ts), and the cooldowns are the ones the engine plays with. Smite also shows its charges in the
// corner and its upgrade (the jungle pet's: Unleashed / Primal Smite) as a coloured frame.
import type { Engine, Unit } from "../match/engine";
import { SMITE, SUMMONER_ICON, SUMMONER_KO, slots } from "../match/summoners";
import { spellImg } from "../data/load";
import { D } from "../store";
import "./summoners.css";

const TIER_KO = ["", " · 1단계 강화", " · 2단계 강화"];

export function SummonerSpells({ e, u }: { e: Engine; u: Unit }) {
  const ver = D().ddVersion;
  return (
    <div class="sum-pair">
      {slots(e, u).map((s) => {
        const left = Math.ceil(s.left);
        const state = s.busy ? "시전 중" : left > 0 ? `${left}초 뒤 사용 가능` : "사용 가능";
        const tier = s.tier ?? 0;
        const extra = s.charges !== undefined ? `${TIER_KO[tier]} · 충전 ${s.charges}/${SMITE.max} · 몬스터 피해 ${SMITE.dmg[tier]}` : "";
        return (
          <span class={`sum ${left > 0 ? "cd" : ""} ${s.busy ? "busy" : ""} ${tier ? `tier${tier}` : ""}`} title={`${SUMMONER_KO[s.name]}${extra} · ${state}`}>
            <img src={spellImg(ver, SUMMONER_ICON[s.name])} alt="" />
            {left > 0 && !s.busy && <b>{left}</b>}
            {s.charges !== undefined && s.charges > 0 && <i>{s.charges}</i>}
          </span>
        );
      })}
    </div>
  );
}
