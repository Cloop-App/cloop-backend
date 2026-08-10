// LearningCards.tsx
// Reference React renderers for the Cloop tutor's end-of-goal / end-of-session
// cards. Drop these into the web app (CloopDev) and branch on message_type in
// the chat message renderer:
//
//   case "goal_revision":   return <GoalRevisionCard data={msg.metadata} />;
//   case "learning_report": return <LearningReportCard data={msg.metadata} />;
//
// The backend persists these as their own message rows (message_type +
// metadata) exactly like the diagram/video cards, so they render in timeline
// order. Inline styles are placeholder purples — move them to your design
// tokens / Tailwind.

import React from "react";

type Definition = { term: string; definition: string };

export interface GoalRevision {
  title?: string;
  definitions?: Definition[];
}

export interface LearningReport {
  title?: string;
  focus_areas?: string[];
  strong_areas?: string[];
  key_definitions?: Definition[];
  recommendation?: string;
}

const card: React.CSSProperties = {
  border: "1px solid #e6e1f5",
  borderRadius: 14,
  padding: 16,
  background: "#faf9ff",
  maxWidth: 560,
  fontSize: 14,
  lineHeight: 1.5,
  color: "#1f2430",
};
const heading: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 15,
  fontWeight: 700,
  color: "#6b40d8",
};
const section: React.CSSProperties = { margin: "12px 0 0" };
const label: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  margin: "0 0 4px",
  display: "flex",
  gap: 6,
};
const listStyle: React.CSSProperties = { margin: 0, padding: 0, listStyle: "none" };
const itemStyle: React.CSSProperties = {
  margin: "4px 0",
  paddingLeft: 18,
  position: "relative",
};

function BulletList({ items, mark = "•" }: { items: string[]; mark?: string }) {
  return (
    <ul style={listStyle}>
      {items.map((t, i) => (
        <li key={i} style={itemStyle}>
          <span style={{ position: "absolute", left: 0 }} aria-hidden>
            {mark}
          </span>
          {t}
        </li>
      ))}
    </ul>
  );
}

function Definitions({ defs }: { defs: Definition[] }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {defs.map((d, i) => (
        <div
          key={i}
          style={{
            background: "#fff",
            border: "1px solid #eee",
            borderRadius: 8,
            padding: "8px 10px",
          }}
        >
          <div style={{ fontWeight: 700 }}>{d.term}</div>
          <div style={{ color: "#444" }}>{d.definition}</div>
        </div>
      ))}
    </div>
  );
}

export function GoalRevisionCard({ data }: { data: GoalRevision }) {
  if (!data?.definitions?.length) return null;
  return (
    <div style={card}>
      <div style={heading}>📌 {data.title || "Remember for your test"}</div>
      <Definitions defs={data.definitions} />
    </div>
  );
}

export function LearningReportCard({ data }: { data: LearningReport }) {
  if (!data) return null;
  return (
    <div style={card}>
      <div style={heading}>🧾 {data.title || "Your learning report"}</div>

      {!!data.focus_areas?.length && (
        <div style={section}>
          <div style={label}>🔴 Focus on this</div>
          <BulletList items={data.focus_areas} />
        </div>
      )}

      {!!data.strong_areas?.length && (
        <div style={section}>
          <div style={label}>🟢 You&apos;re strong at</div>
          <BulletList items={data.strong_areas} />
        </div>
      )}

      {!!data.key_definitions?.length && (
        <div style={section}>
          <div style={label}>📖 Key definitions</div>
          <Definitions defs={data.key_definitions} />
        </div>
      )}

      {data.recommendation && (
        <div style={{ ...section, background: "#efe9ff", borderRadius: 8, padding: "8px 10px" }}>
          <div style={label}>✅ Recommendation</div>
          <div>{data.recommendation}</div>
        </div>
      )}
    </div>
  );
}
