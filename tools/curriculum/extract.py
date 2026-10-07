"""
Workbook -> normalized curriculum JSON.

Deterministic and side-effect free: reads the knowledge-graph workbook and
writes JSON the Node importer loads. Kept separate from the importer so the
extraction can be reviewed and diffed on its own.

The naming layer is the point of this file. The workbook says "CBSE" and "IX";
users.board says "Central Board of Secondary Education" and users.grade_level
says "Class 9". Importing the workbook's own spelling would create a second
catalog nobody is enrolled in -- which is exactly how the generated data forked
into 26 redundant subjects over a colon versus an em dash.
"""

import json, sys, collections, openpyxl

# Workbook `System` -> the board string users actually carry.
BOARDS = {
    "CBSE": "Central Board of Secondary Education",
    "ICSE": "Indian Certificate of Secondary Education",
    "ISC": "Indian School Certificate",
}
# Entrance exams are not school boards; they keep their own name as the board
# so a student preparing for JEE enrols in a distinct catalog.
TEST_PREP = {"JEE Main + Advanced", "NEET UG", "KCET"}

ROMAN = {"VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12}

# Subject name -> the short code users.subjects holds, where one exists.
CODES = {
    "Science": "SCI", "Mathematics": "MATH", "English": "ENG",
    "Social Science": "SOC", "Hindi/Second Language": "HIN",
    "Computer/ICT": "CMP", "Computer Science": "CMP",
    "Computer Applications": "CMP", "English Language": "ENG",
    "English Literature": "ENG", "Second Language": "HIN",
    "History/Civics/Geography": "SOC", "Physics": "SCI",
    "Chemistry": "SCI", "Biology": "SCI",
}


def normalise_grade(raw):
    """'IX' -> 'Class 9'; 'XI-XII' -> 'Class 11-12'. None when unrecognised."""
    s = str(raw or "").strip().upper()
    if s in ROMAN:
        return f"Class {ROMAN[s]}"
    if "-" in s:
        parts = [p.strip() for p in s.split("-")]
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


def subject_key(board, grade, name):
    return f"{board}||{grade}||{name}"


def sheet_rows(wb, name):
    ws = wb[name]
    it = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(it)]
    for row in it:
        yield dict(zip(header, row))


def clean(v):
    s = "" if v is None else str(v).strip()
    return s or None


def main(xlsx_path, out_path):
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)

    subjects, chapters, topics, concepts = {}, {}, [], []
    skipped = collections.Counter()

    # ── chapters ─────────────────────────────────────────────────────────
    #
    # Granularity differs by system: CBSE writes one row per chapter, ICSE one
    # row per chapter x topic. Keying on the node id therefore turns ICSE's 43
    # real chapters into 183 rows with "Mechanics" repeated fifteen times, so
    # chapters are keyed on (subject, title) and node ids collected against
    # them for the topic join.
    node_to_chapter = {}
    chapter_order = collections.Counter()
    for r in sheet_rows(wb, "Curriculum_Master_v9"):
        grade = normalise_grade(r.get("Class"))
        if not grade:
            skipped["unrecognised class"] += 1
            continue
        board, is_prep = normalise_board(r.get("System"))
        name = clean(r.get("Subject"))
        node = clean(r.get("Curriculum Node ID"))
        title = clean(r.get("Chapter"))
        if not (name and node and title):
            skipped["missing subject/node/chapter"] += 1
            continue

        key = subject_key(board, grade, name)
        if key not in subjects:
            subjects[key] = {
                "key": key, "board": board, "grade": grade, "name": name,
                "code": CODES.get(name), "is_test_prep": is_prep,
                "system_raw": clean(r.get("System")), "class_raw": clean(r.get("Class")),
                "source_authority": clean(r.get("Source Authority")),
                "source_year": clean(r.get("Source Year")),
                "official_source": clean(r.get("Official Source")),
            }

        ch_key = f"{key}||{title}"
        if ch_key not in chapters:
            chapter_order[key] += 1
            chapters[ch_key] = {
                "chapter_key": ch_key, "subject_key": key, "title": title,
                "unit": clean(r.get("Unit")),
                "reconciliation_status": clean(r.get("Reconciliation Status")),
                "verified": clean(r.get("Reconciliation Status")) == "SOURCE-RECONCILED",
                "order": chapter_order[key],
                "node_ids": [],
            }
        chapters[ch_key]["node_ids"].append(node)
        node_to_chapter[node] = ch_key

    # ── topics ───────────────────────────────────────────────────────────
    per_chapter = collections.Counter()
    seen_topic = set()
    for r in sheet_rows(wb, "Topic_Master_v9"):
        node = clean(r.get("Curriculum Node ID"))
        title = clean(r.get("Topic"))
        ch_key = node_to_chapter.get(node)
        if not (title and ch_key):
            skipped["topic without a known chapter"] += 1
            continue
        if (ch_key, title) in seen_topic:
            skipped["duplicate topic in chapter"] += 1
            continue
        seen_topic.add((ch_key, title))
        status = clean(r.get("Topic_Derivation_Status")) or ""
        per_chapter[ch_key] += 1
        topics.append({
            "chapter_key": ch_key, "title": title, "order": per_chapter[ch_key],
            "derivation_status": status,
            # Only rows the workbook itself calls existing are treated as
            # sourced. The other 3,161 sit in its own validation queue and it
            # explicitly does not claim them.
            "verified": status.lower().startswith("existing"),
        })

    # ── concepts ─────────────────────────────────────────────────────────
    for r in sheet_rows(wb, "Concept_Graph"):
        node_subject = clean(r.get("Subject"))
        code = clean(r.get("Concept ID"))
        concept = clean(r.get("Concept"))
        if not (code and concept):
            skipped["concept missing id/name"] += 1
            continue
        concepts.append({
            "code": code, "name": concept, "subject": node_subject,
            "class_level": ROMAN.get(str(r.get("Class") or "").strip().upper()),
            "topic": clean(r.get("Topic")), "chapter": clean(r.get("Chapter")),
            "difficulty": clean(r.get("Difficulty")),
            "prerequisites": clean(r.get("Prerequisite Concept IDs")),
            "misconception": clean(r.get("Common Misconception")),
            "learning_outcome": clean(r.get("Learning Outcome")),
        })

    wb.close()

    payload = {
        "subjects": sorted(subjects.values(), key=lambda s: (s["board"], s["grade"], s["name"])),
        "chapters": sorted(chapters.values(), key=lambda c: (c["subject_key"], c["order"])),
        "topics": topics,
        "concepts": concepts,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"subjects {len(payload['subjects'])}  chapters {len(payload['chapters'])}  "
          f"topics {len(topics)}  concepts {len(concepts)}")
    print(f"  verified chapters: {sum(1 for c in payload['chapters'] if c['verified'])}")
    print(f"  verified topics:   {sum(1 for t in topics if t['verified'])}")
    if skipped:
        print("  skipped:", dict(skipped))

    grid = collections.Counter((s["board"], s["grade"]) for s in payload["subjects"])
    print("\n  board x grade (subjects):")
    for (b, g), n in sorted(grid.items()):
        print(f"    {b[:46]:<46} {g:<14} {n:>3}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
