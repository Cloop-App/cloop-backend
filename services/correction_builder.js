/**
 * Deterministic correction builder.
 *
 * Produces the "CORRECTIONS" strikethrough shown to students for a WRONG answer:
 * the student's wrong word(s) wrapped in <del>, the correct word(s) in <ins>,
 * and any shared words kept as plain text. Because it's a real word-level diff
 * (not the model free-forming a string), it never mashes words together or
 * invents text — e.g.:
 *   "chemicals"        vs "pollutants"      -> <del>chemicals</del><ins>pollutants</ins>
 *   "the iris"         vs "the pupil"       -> the <del>iris</del><ins>pupil</ins>
 *   "water pollution"  vs "eutrophication"  -> <del>water pollution</del><ins>eutrophication</ins>
 *
 * Pair with CSS: del{text-decoration:line-through;color:#d33} ins{color:#2a7;text-decoration:none}
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function words(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Word-level LCS diff → HTML with only <del>/<ins> tags.
 * @param {string} student   the student's (wrong) answer/term
 * @param {string} correct   the correct answer/term
 * @returns {string|null} diff HTML, or null if there's nothing to show
 */
function buildWordDiff(student, correct) {
  const a = words(student);
  const b = words(correct);
  if (!b.length) return null;
  if (!a.length) return `<ins>${escapeHtml(correct)}</ins>`;

  // LCS table.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].toLowerCase() === b[j].toLowerCase()
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the table into eq/del/ins ops.
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      ops.push({ t: "eq", w: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "del", w: a[i] });
      i++;
    } else {
      ops.push({ t: "ins", w: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", w: a[i++] });
  while (j < m) ops.push({ t: "ins", w: b[j++] });

  // Render, merging adjacent del/ins runs so we get one <del>…</del><ins>…</ins>.
  const parts = [];
  let del = [];
  let ins = [];
  const flush = () => {
    if (!del.length && !ins.length) return;
    // Emit the del+ins run as ONE segment so <del>…</del><ins>…</ins> are
    // adjacent (no space between them), matching the CORRECTIONS card.
    let seg = "";
    if (del.length) seg += `<del>${escapeHtml(del.join(" "))}</del>`;
    if (ins.length) seg += `<ins>${escapeHtml(ins.join(" "))}</ins>`;
    parts.push(seg);
    del = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.t === "eq") {
      flush();
      parts.push(escapeHtml(op.w));
    } else if (op.t === "del") del.push(op.w);
    else ins.push(op.w);
  }
  flush();

  const html = parts.join(" ");
  // If nothing was actually changed, there's no correction to show.
  return /<del>|<ins>/.test(html) ? html : null;
}

/**
 * Build the full correction payload for a wrong answer:
 *   { complete_answer, diff_html }
 * `complete_answer` is the one-sentence correct statement (top bubble);
 * `diff_html` is the strikethrough correction (CORRECTIONS block).
 *
 * @param {object} args
 * @param {string} args.studentAnswer
 * @param {string} args.correctTerm     the concise correct answer/term to swap in
 * @param {string} [args.completeAnswer] the full correct sentence (defaults built from term)
 */
function buildCorrection({ studentAnswer, correctTerm, completeAnswer }) {
  return {
    complete_answer: completeAnswer || correctTerm || "",
    diff_html: buildWordDiff(studentAnswer, correctTerm),
  };
}

module.exports = { buildWordDiff, buildCorrection, escapeHtml };
