"""
v11.1 workbook -> normalized curriculum JSON.

v11.1 supersedes v10: Classes VI-VII are added from NCERT textbook PDFs, the
duplicated ICSE VIII-X pools are rebuilt per class, and the concept layer
finally carries misconceptions, difficulty and a real prerequisite graph.

Two judgements are encoded here, both conservative:

  * `verified` is true only for anchors the workbook calls PRIMARY_* or
    SOURCE-RECONCILED. SCOPE-QUALIFIED (Class VIII, which no board examines)
    and SCHOOL_SELECTED (where the textbook is the school's choice) are not
    board syllabus and must not be presented as such.

  * Legacy prerequisite edges are dropped. The workbook's own validation queue
    marks them P0 with the production rule "DO NOT ENFORCE LEGACY HARD GATING",
    and an unvalidated edge in a gating graph sends a student backwards.
"""

import json, sys, collections, openpyxl

BOARDS = {
    "CBSE": "Central Board of Secondary Education",
    "ICSE": "Indian Certificate of Secondary Education",
    "ISC": "Indian School Certificate",
}
TEST_PREP = {"JEE Main + Advanced", "JEE Main", "JEE Advanced", "NEET UG", "KCET"}
ROMAN = {"VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12}

CODES = {
    "Science": "SCI", "Mathematics": "MATH", "English": "ENG",
    "Social Science": "SOC", "Hindi/Second Language": "HIN", "Second Language": "HIN",
    "Computer/ICT": "CMP", "Computer Science": "CMP", "Computer Applications": "CMP",
    "English Language": "ENG", "English Literature": "ENG",
    "History/Civics/Geography": "SOC", "Physics": "SCI", "Chemistry": "SCI",
    "Biology": "SCI",
}

# Anchors the workbook stands behind as official.
VERIFIED_PREFIXES = ("PRIMARY_VERIFIED", "PRIMARY_BOOK_CONFIRMED",
                     "PRIMARY_FRAMEWORK", "SOURCE-RECONCILED")


def normalise_grade(raw):
    s = str(raw or "").strip().upper()
    if s in ROMAN:
        return f"Class {ROMAN[s]}"
    if "-" in s or "–" in s:
        parts = [p.strip() for p in s.replace("–", "-").split("-")]
        if all(p in ROMAN for p in parts):
            return "Class " + "-".join(str(ROMAN[p]) for p in parts)
    return None


def normalise_board(system):
    s = str(system or "").strip()
    if s in BOARDS:
        return BOARDS[s], False
    if s in TEST_PREP:
        return s, True
    return s, False


def clean(v):
    s = "" if v is None else str(v).strip()
    return s or None


def sheet_rows(wb, name):
    ws = wb[name]
    it = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(it)]
    for row in it:
        if any(c is not None and str(c).strip() for c in row):
            yield dict(zip(header, row))


def main(xlsx_path, out_path):
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)

    subjects, chapters, topics, concepts, prereqs = {}, {}, [], [], []
    skipped = collections.Counter()
    chapter_order = collections.Counter()
    node_to_chapter = {}

    # ── curriculum anchors ───────────────────────────────────────────────
    for r in sheet_rows(wb, "Curriculum_Master_v11"):
        grade = normalise_grade(r.get("Class"))
        name = clean(r.get("Subject"))
        title = clean(r.get("Chapter"))
        node = clean(r.get("Curriculum Node ID"))
        if not (grade and name and title and node):
            skipped["incomplete anchor"] += 1
            continue

        board, is_prep = normalise_board(r.get("System"))
        key = f"{board}||{grade}||{name}"
        status = clean(r.get("Authority Status")) or ""

        if key not in subjects:
            subjects[key] = {
                "key": key, "board": board, "grade": grade, "name": name,
                "code": CODES.get(name), "is_test_prep": is_prep,
                "source_authority": clean(r.get("Source Authority")),
                "source_year": clean(r.get("Source Year")),
                "official_source": clean(r.get("Source URL")),
            }

        ch_key = f"{key}||{title}"
        if ch_key not in chapters:
            chapter_order[key] += 1
            chapters[ch_key] = {
                "chapter_key": ch_key, "subject_key": key, "title": title,
                "unit": clean(r.get("Unit")),
                "reconciliation_status": status,
                "verified": status.startswith(VERIFIED_PREFIXES),
                "order": chapter_order[key],
                "node_ids": [],
            }
        chapters[ch_key]["node_ids"].append(node)
        node_to_chapter[node] = ch_key

        topic_title = clean(r.get("Topic"))
        if topic_title:
            topics.append({
                "chapter_key": ch_key, "title": topic_title,
                "derivation_status": clean(r.get("Derivation Status")) or "",
                "verified": chapters[ch_key]["verified"],
            })

    # Topics arrive one per anchor row; number them within their chapter and
    # drop repeats, since several anchors can share a chapter.
    seen, ordered = set(), collections.Counter()
    deduped = []
    for t in topics:
        k = (t["chapter_key"], t["title"])
        if k in seen:
            skipped["duplicate topic"] += 1
            continue
        seen.add(k)
        ordered[t["chapter_key"]] += 1
        t["order"] = ordered[t["chapter_key"]]
        deduped.append(t)
    topics = deduped

    # ── concepts ─────────────────────────────────────────────────────────
    for r in sheet_rows(wb, "Concept_Master_v11"):
        code = clean(r.get("Concept ID"))
        concept = clean(r.get("Concept"))
        if not (code and concept):
            skipped["concept missing id/name"] += 1
            continue
        difficulty = clean(r.get("Difficulty Heuristic"))
        concepts.append({
            "code": code, "name": concept, "subject": clean(r.get("Subject")),
            # The anchor this concept hangs off. Without it the concept layer
            # cannot be joined back to a topic, and so cannot reach a student.
            "node_id": clean(r.get("Curriculum Node ID")),
            "topic": clean(r.get("Topic")),
            "chapter": clean(r.get("Chapter")),
            "class_level": ROMAN.get(str(r.get("Class") or "").strip().upper()),
            "difficulty": int(difficulty) if (difficulty or "").isdigit() else None,
            "learning_objective": clean(r.get("Learning Objective")),
            "bloom": clean(r.get("Bloom Level")),
            "misconception": clean(r.get("Common Misconception")),
            "provenance": clean(r.get("Concept Provenance")),
            "source_url": clean(r.get("Source URL")),
            "production_status": clean(r.get("Production Status")),
        })

    # ── prerequisite graph (v11 edges only) ──────────────────────────────
    for r in sheet_rows(wb, "Prerequisite_Graph_v11"):
        version = (clean(r.get("Graph Version")) or "").lower()
        pre, dep = clean(r.get("Prerequisite Concept ID")), clean(r.get("Dependent Concept ID"))
        if not (pre and dep) or pre == dep:
            skipped["bad edge"] += 1
            continue
        if "legacy" in version:
            skipped["legacy edge (not enforced)"] += 1
            continue
        prereqs.append({
            "prerequisite_code": pre, "dependent_code": dep,
            "edge_type": clean(r.get("Edge Type")),
            "validation_status": clean(r.get("Validation Status")),
            "graph_version": clean(r.get("Graph Version")),
            "rationale": clean(r.get("Rationale")),
        })

    wb.close()

    payload = {
        "subjects": sorted(subjects.values(), key=lambda s: (s["board"], s["grade"], s["name"])),
        "chapters": sorted(chapters.values(), key=lambda c: (c["subject_key"], c["order"])),
        "topics": topics, "concepts": concepts, "prerequisites": prereqs,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"subjects {len(payload['subjects'])}  chapters {len(payload['chapters'])}  "
          f"topics {len(topics)}  concepts {len(concepts)}  prerequisite edges {len(prereqs)}")
    print(f"  verified chapters: {sum(1 for c in payload['chapters'] if c['verified'])}")
    print(f"  concepts with a misconception: {sum(1 for c in concepts if c['misconception'])}")
    print(f"  concepts with a difficulty:    {sum(1 for c in concepts if c['difficulty'])}")
    if skipped:
        print("  skipped:", dict(skipped))

    grid = collections.Counter((s["board"], s["grade"]) for s in payload["subjects"])
    print("\n  board x grade (subjects):")
    for (b, g), n in sorted(grid.items()):
        print(f"    {b[:44]:<44} {g:<14} {n:>3}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
