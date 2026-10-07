"""
Verify the imported catalog against the official NCERT textbook PDFs.

    python3 tools/curriculum/verify_against_source.py <catalog.json> <pdf>...

Each NCERT prelims PDF carries the book's Contents page. This parses that page
for the authoritative chapter list and diffs it against what the importer
loaded, so "verified" stops meaning "the workbook said so" and starts meaning
"checked against the book".

Comparison is on a normalised form — case, unicode punctuation and whitespace
differ freely between a PDF's typesetting and a spreadsheet cell, and none of
those differences are errors. A difference that survives normalisation is real.
"""

import json, re, subprocess, sys, unicodedata, collections

# Which catalog subject each NCERT book is the source for.
BOOKS = {
    "fegp1ps": ("Central Board of Secondary Education", "Class 6", "Mathematics", "Ganita Prakash 6"),
    "fecu1ps": ("Central Board of Secondary Education", "Class 6", "Science", "Curiosity 6"),
    "fepr1ps": ("Central Board of Secondary Education", "Class 6", "English", "Poorvi 6"),
    "gegp1ps": ("Central Board of Secondary Education", "Class 7", "Mathematics", "Ganita Prakash 7 Part I"),
    "gecu1ps": ("Central Board of Secondary Education", "Class 7", "Science", "Curiosity 7"),
    "gepr1ps": ("Central Board of Secondary Education", "Class 7", "English", "Poorvi 7"),
}


def normalise(s):
    """Fold away everything that is typesetting rather than content."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = re.sub(r"[‐-―]", "-", s)          # every dash becomes "-"
    s = re.sub(r"^(chapter|unit)\s*\d+\s*[:.\-]?\s*", "", s, flags=re.I)
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def pdf_text(path):
    raw = subprocess.run(["pdftotext", "-layout", path, "-"],
                         capture_output=True, text=True, check=True).stdout
    # NCERT typesetting leaves stray control characters mid-line (a \x08 sits
    # between a chapter title and its page number). They are invisible in a
    # reader and fatal to a regex, so strip them before anything else.
    return re.sub(r"[\x00-\x08\x0b-\x1f]", " ", raw)


def parse_contents(text):
    """
    Chapter titles from a Contents page.

    Two shapes appear: maths and science list "Chapter N" then the title on the
    next line; English lists "Unit N: Theme" then indented text titles. Both are
    handled, and a trailing page number is stripped.
    """
    lines = [l.rstrip() for l in text.splitlines()]
    start = next((i for i, l in enumerate(lines)
                  if re.match(r"^\s*contents\s*$", l, re.I)), None)
    if start is None:
        return [], []

    window = lines[start + 1: start + 90]
    # A text title can wrap onto a second line ("Ila Sachani:" / "Embroidering
    # Dreams with her Feet"). Join a line that ends in a colon to the next.
    joined = []
    skip = False
    for i, l in enumerate(window):
        if skip:
            skip = False
            continue
        if l.strip().endswith(":") and not re.match(r"^\s*Unit\s+\d+", l) and i + 1 < len(window):
            joined.append(l.rstrip() + " " + window[i + 1].strip())
            skip = True
        else:
            joined.append(l)
    window = joined
    chapters, units, pending_unit = [], [], None

    for i, raw in enumerate(window):
        line = raw.strip()
        if not line or re.match(r"^(reprint|prelims|\d+_?prelims)", line, re.I):
            continue

        m = re.match(r"^(Chapter|CHAPTER)\s+(\d+)\s*$", line)
        if m:
            for nxt in window[i + 1:]:
                t = re.sub(r"\s+[ivxlcdm\d]+\s*$", "", nxt.strip())
                t = re.sub(r"(\d+)$", "", t).strip()
                if t and not re.match(r"^(Chapter|CHAPTER)\s+\d+", t):
                    chapters.append(t)
                    break
            continue

        u = re.match(r"^Unit\s+\d+\s*:\s*(.+)$", line)
        if u:
            pending_unit = u.group(1).strip()
            units.append(pending_unit)
            continue

        if pending_unit:
            t = re.sub(r"\s+\d+\s*$", "", line).strip()
            if t and not re.match(r"^(Foreword|About|Note|Contents)", t, re.I) and len(t) > 2:
                chapters.append(t)

    return chapters, units


def main(catalog_path, pdf_paths):
    catalog = json.load(open(catalog_path, encoding="utf-8"))
    by_subject = collections.defaultdict(list)
    subj_of = {s["key"]: s for s in catalog["subjects"]}
    for c in catalog["chapters"]:
        s = subj_of[c["subject_key"]]
        by_subject[(s["board"], s["grade"], s["name"])].append(c["title"])

    # Several books can be the source for one subject (Ganita Prakash 7 ships
    # as Part I and Part II), so union them before diffing.
    sources = collections.defaultdict(lambda: {"titles": [], "labels": []})
    for path in pdf_paths:
        stem = next((k for k in BOOKS if k in path), None)
        if not stem:
            print(f"  (unmapped file: {path})")
            continue
        board, grade, subject, label = BOOKS[stem]
        official, _units = parse_contents(pdf_text(path))
        sources[(board, grade, subject)]["titles"].extend(official)
        sources[(board, grade, subject)]["labels"].append(label)

    overall = collections.Counter()
    print(f"{'source':<34} {'official':>8} {'catalog':>8} {'matched':>8} {'missing':>8} {'extra':>6}")
    print("-" * 78)
    details = []

    for (board, grade, subject), src in sorted(sources.items()):
        official = src["titles"]
        label = " + ".join(src["labels"])
        catalog_titles = by_subject.get((board, grade, subject), [])

        off_n = {normalise(t): t for t in official}
        cat_n = {normalise(t): t for t in catalog_titles}

        matched = sorted(set(off_n) & set(cat_n))
        missing = sorted(set(off_n) - set(cat_n))   # in the book, not in Cloop
        extra = sorted(set(cat_n) - set(off_n))     # in Cloop, not in the book

        print(f"{label[:33]:<34} {len(off_n):>8} {len(cat_n):>8} {len(matched):>8} "
              f"{len(missing):>8} {len(extra):>6}")
        overall["official"] += len(off_n)
        overall["matched"] += len(matched)
        overall["missing"] += len(missing)
        overall["extra"] += len(extra)
        details.append((label, [off_n[k] for k in missing], [cat_n[k] for k in extra]))

    print("-" * 78)
    pct = overall["matched"] / overall["official"] * 100 if overall["official"] else 0
    print(f"{'TOTAL':<34} {overall['official']:>8} {'':>8} {overall['matched']:>8} "
          f"{overall['missing']:>8} {overall['extra']:>6}   ({pct:.1f}% of official matched)")

    for label, missing, extra in details:
        if missing or extra:
            print(f"\n{label}")
            for t in missing:
                print(f"   MISSING from catalog : {t}")
            for t in extra:
                print(f"   EXTRA in catalog     : {t}")

    return 0 if overall["missing"] == 0 and overall["extra"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
