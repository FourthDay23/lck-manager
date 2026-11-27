// Start screen footer tabs: 서비스 안내 / 패치노트 / 개인정보처리방침 / 이용약관.
// A tab opens the document in a modal; the address gets #guide / #patchnotes / #privacy / #terms so a link
// (lck-manager.kro.kr/#privacy) opens that document straight away.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CURRENT_VERSION, PATCH_NOTES } from "./patchnotes";
import { PRIVACY_EFFECTIVE, PRIVACY_POLICY, SERVICE_GUIDE, TERMS, TERMS_EFFECTIVE } from "./docs";
import "./info.css";

type TabId = "guide" | "patchnotes" | "privacy" | "terms";
const TABS: { id: TabId; label: string }[] = [
  { id: "guide", label: "서비스 안내" },
  { id: "patchnotes", label: "패치노트" },
  { id: "privacy", label: "개인정보처리방침" },
  { id: "terms", label: "이용약관" },
];

function tabFromHash(): TabId | null {
  if (typeof location === "undefined") return null;
  const h = location.hash.slice(1); // the ids are plain ASCII: no decoding, so a stray "#%" cannot throw
  return TABS.some((t) => t.id === h) ? (h as TabId) : null;
}

const urlFor = (id: TabId | null) => location.pathname + location.search + (id ? `#${id}` : "");

/** The row of tabs; place it in the start screen footer. */
export function InfoTabs() {
  const [open, setOpen] = useState<TabId | null>(tabFromHash);
  // Opening from the footer adds a history entry so the phone's back button closes the document;
  // a page that was opened at #privacy has no entry of ours to go back to, so closing just drops the hash.
  const pushed = useRef(false);
  useEffect(() => {
    const onNav = () => {
      pushed.current = false;
      setOpen(tabFromHash());
    };
    addEventListener("hashchange", onNav);
    addEventListener("popstate", onNav);
    return () => {
      removeEventListener("hashchange", onNav);
      removeEventListener("popstate", onNav);
    };
  }, []);
  const show = (id: TabId | null) => {
    if (id && !open) {
      history.pushState(history.state, "", urlFor(id));
      pushed.current = true;
    } else if (!id && pushed.current) {
      pushed.current = false;
      history.back(); // popstate / hashchange then close it
    } else {
      history.replaceState(history.state, "", urlFor(id));
    }
    setOpen(id);
  };
  return (
    <>
      <nav class="info-tabs" aria-label="안내">
        {TABS.map((t) => (
          <button type="button" class={`info-tab ${t.id === "privacy" ? "strong" : ""}`} onClick={() => show(t.id)}>{t.label}</button>
        ))}
        <span class="info-ver">v{CURRENT_VERSION}</span>
      </nav>
      {open && <InfoModal tab={open} onTab={show} onClose={() => show(null)} />}
    </>
  );
}

/** Same look as components.tsx Modal, but the tab row and close button stay put while the document scrolls. */
function InfoModal({ tab, onTab, onClose }: { tab: TabId; onTab: (id: TabId) => void; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const pressedBg = useRef(false); // a text drag that ends on the backdrop is not a click on it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    // keyboard focus goes into the dialog and back to where it was when it closes
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [tab]);
  const label = TABS.find((t) => t.id === tab)!.label;
  return (
    <div
      class="modal-bg"
      onPointerDown={(e) => { pressedBg.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBg.current) onClose(); }}
    >
      <div class="modal frame info-box" role="dialog" aria-modal="true" aria-label={label}>
        <div class="info-head">
          <div class="tabs info-head-tabs" role="tablist">
            {TABS.map((t) => (
              <button type="button" role="tab" aria-selected={t.id === tab} class={`btn small ${t.id === tab ? "on" : ""}`} onClick={() => onTab(t.id)}>{t.label}</button>
            ))}
          </div>
          <button type="button" class="btn small" ref={closeBtn} onClick={onClose}>닫기</button>
        </div>
        <div class="info-body" ref={body}>
        <h2 class="info-title">{label}</h2>
        {tab === "guide" && <Doc text={SERVICE_GUIDE} />}
        {tab === "patchnotes" && <PatchNotes />}
        {tab === "privacy" && (
          <>
            <div class="info-date">시행일 {PRIVACY_EFFECTIVE}</div>
            <Doc text={PRIVACY_POLICY} />
          </>
        )}
        {tab === "terms" && (
          <>
            <div class="info-date">시행일 {TERMS_EFFECTIVE}</div>
            <Doc text={TERMS} />
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function PatchNotes() {
  return (
    <div class="patch-list">
      {PATCH_NOTES.map((n, i) => (
        <section class="patch">
          <div class="patch-head">
            <b class="patch-ver">v{n.version}</b>
            <span class="patch-name">{n.title}</span>
            {i === 0 && <span class="tag gold">최신</span>}
            <span class="patch-date">{n.date.replaceAll("-", ".")}</span>
          </div>
          <ul class="patch-items">{n.items.map((x) => <li>{x}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}

// ---------- the light markup of docs.ts ----------
const CLAUSE = /^[①-⑳]\s/; // ① … ⑳ (항)
const ITEM = /^\d+\.\s/; // 1. 2. … (호), one step further in
const LINK_RE = /(https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

function linkify(text: string): ComponentChildren {
  const parts = text.split(LINK_RE);
  return parts.map((p, i) => {
    if (i % 2 === 0) return p;
    if (p.includes("@") && !p.startsWith("http")) return <a href={`mailto:${p}`}>{p}</a>;
    return <a href={p} target="_blank" rel="noopener noreferrer">{p}</a>;
  });
}

function Doc({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const out: ComponentChildren[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i].replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      out.push(
        <div class="info-table-wrap">
          <table class="t info-table">
            <thead><tr>{rows[0].map((c) => <th>{c}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r) => <tr>{r.map((c) => <td>{linkify(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*- /.test(l)) {
      const items: ComponentChildren[] = [];
      for (; i < lines.length && /^\s*- /.test(lines[i]); i++) {
        const deep = /^\s{2,}- /.test(lines[i]);
        items.push(<li class={deep ? "deep" : ""}>{linkify(lines[i].replace(/^\s*- /, ""))}</li>);
      }
      out.push(<ul class="info-ul">{items}</ul>);
      continue;
    }
    if (l.startsWith("### ")) out.push(<h4 class="info-h4">{l.slice(4)}</h4>);
    else if (l.startsWith("## ")) out.push(<h3 class="info-h3">{l.slice(3)}</h3>);
    else if (CLAUSE.test(l)) out.push(<p class="info-num">{linkify(l)}</p>);
    else if (ITEM.test(l)) out.push(<p class="info-num sub">{linkify(l)}</p>);
    else out.push(<p class="info-p">{linkify(l)}</p>);
    i++;
  }
  return <div class="info-doc">{out}</div>;
}
