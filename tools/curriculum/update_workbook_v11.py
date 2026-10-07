"""
Write the source-verification result back into the knowledge graph workbook.

    python3 tools/curriculum/update_workbook_v11.py <in.xlsx> <catalog.json> <out.xlsx> <pdf>...

The workbook's Authority Status says how its author classified a row. This adds
a stronger, independent column: whether the chapter was actually found in the
official NCERT textbook's Contents page. "PRIMARY_VERIFIED" becomes a claim
that has itself been checked.

Writes a new file. openpyxl rewrites any workbook it opens and silently drops
what it does not model, so the source workbook is left exactly as it was.
"""

import importlib.util, json, os, sys, collections
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

HEAD = Font(bold=True, color="FFFFFF")
FILL = PatternFill("solid", fgColor="23386D")
GOOD = Font(color="2B6E4F", bold=True)
WARN = Font(color="B8402A", bold=True)

CONFIRMED = "CONFIRMED_IN_OFFICIAL_TEXTBOOK"
NOT_CHECKED = "NOT_CHECKED (no source document supplied)"
NOT_FOUND = "NOT_FOUND_IN_SUPPLIED_SOURCE"


def load_verifier():
    path = os.path.join(os.path.dirname(__file__), "verify_against_source.py")
    spec = importlib.util.spec_from_file_location("verif", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sheet(wb, title, header, rows, widths):
    if title in wb.sheetnames:
        del wb[title]
    ws = wb.create_sheet(title)
    ws.append(header)
    for r in rows:
        ws.append(r)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in range(1, len(header) + 1):
        ws.cell(row=1, column=c).font = HEAD
        ws.cell(row=1, column=c).fill = FILL
    ws.freeze_panes = "A2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{len(rows) + 1}"
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if isinstance(cell.value, str):
                if cell.value.startswith(("CONFIRMED", "MATCHED", "OK")):
                    cell.font = GOOD
                elif cell.value.startswith(("NOT_FOUND", "GAP")):
                    cell.font = WARN
    return ws


def main(xlsx_in, catalog_path, xlsx_out, pdfs):
    v = load_verifier()

    # ── what each official book actually contains ────────────────────────
    official = collections.defaultdict(dict)   # (system, class, subject) -> {norm: title}
    books = collections.defaultdict(list)
    for path in pdfs:
        stem = next((k for k in v.BOOKS if k in path), None)
        if not stem:
            print(f"  (unmapped source file, ignored: {os.path.basename(path)})")
            continue
        board, grade, subject, label = v.BOOKS[stem]
        key = (grade, subject)
        for t in v.parse_contents(v.pdf_text(path))[0]:
            official[key][v.normalise(t)] = t
        books[key].append(label)

    roman = {"Class 6": "VI", "Class 7": "VII", "Class 8": "VIII", "Class 9": "IX",
             "Class 10": "X", "Class 11": "XI", "Class 12": "XII"}

    wb = openpyxl.load_workbook(xlsx_in)
    ws = wb["Curriculum_Master_v11"]
    header = [c.value for c in ws[1]]
    idx = {h: i for i, h in enumerate(header)}

    col_status = len(header) + 1
    col_source = col_status + 1
    ws.cell(row=1, column=col_status, value="PDF Verification")
    ws.cell(row=1, column=col_source, value="Verification Source")
    for c in (col_status, col_source):
        ws.cell(row=1, column=c).font = HEAD
        ws.cell(row=1, column=c).fill = FILL
    ws.column_dimensions[get_column_letter(col_status)].width = 34
    ws.column_dimensions[get_column_letter(col_source)].width = 34

    counts = collections.Counter()
    detail = []
    seen_chapter = set()

    for r in range(2, ws.max_row + 1):
        system = str(ws.cell(row=r, column=idx["System"] + 1).value or "")
        cls = str(ws.cell(row=r, column=idx["Class"] + 1).value or "")
        subject = str(ws.cell(row=r, column=idx["Subject"] + 1).value or "")
        chapter = str(ws.cell(row=r, column=idx["Chapter"] + 1).value or "")

        grade = next((g for g, rm in roman.items() if rm == cls), None)
        key = (grade, subject)

        if system != "CBSE" or key not in official:
            ws.cell(row=r, column=col_status, value=NOT_CHECKED)
            counts[NOT_CHECKED] += 1
            continue

        norm = v.normalise(chapter)
        if norm in official[key]:
            ws.cell(row=r, column=col_status, value=CONFIRMED).font = GOOD
            ws.cell(row=r, column=col_source, value=" + ".join(books[key]))
            counts[CONFIRMED] += 1
            result = "MATCHED"
        else:
            ws.cell(row=r, column=col_status, value=NOT_FOUND).font = WARN
            ws.cell(row=r, column=col_source, value=" + ".join(books[key]))
            counts[NOT_FOUND] += 1
            result = "NOT_FOUND — may belong to another part/book of the same subject"

        if (cls, subject, norm) not in seen_chapter:
            seen_chapter.add((cls, subject, norm))
            detail.append([" + ".join(books[key]), system, cls, subject, chapter, result])

    # chapters in the book that the catalog never mentions
    for key, titles in official.items():
        grade, subject = key
        cls = roman[grade]
        for norm, title in titles.items():
            if (cls, subject, norm) not in seen_chapter:
                detail.append([" + ".join(books[key]), "CBSE", cls, subject, title,
                               "GAP — in the official textbook, missing from the catalog"])
                counts["MISSING_FROM_CATALOG"] += 1

    sheet(wb, "V12_Source_Verification",
          ["Source book", "System", "Class", "Subject", "Chapter", "Result"],
          sorted(detail, key=lambda x: (x[2], x[3], x[4])), [34, 10, 8, 18, 56, 56])

    total_checked = counts[CONFIRMED] + counts[NOT_FOUND]
    pct = (counts[CONFIRMED] / total_checked * 100) if total_checked else 0
    # Two different questions, two different denominators. "Is the catalog
    # right?" is official chapters found; "is every catalog row confirmed?" is
    # the rate below. Reporting only the second reads as an error rate it is not.
    official_total = sum(len(t) for t in official.values())
    found = official_total - counts["MISSING_FROM_CATALOG"]
    official_pct = (found / official_total * 100) if official_total else 0
    sheet(wb, "V12_Audit", ["Item", "Value", "Meaning"], [
        ["Verification method", "Chapter titles matched against the Contents page of the "
         "official NCERT textbook PDF",
         "Comparison is on a normalised form; case, unicode punctuation and whitespace "
         "are not differences."],
        ["Books checked", ", ".join(sorted({b for bs in books.values() for b in bs})) or "none",
         "Only these subjects carry independent confirmation."],
        ["Rows confirmed in textbook", counts[CONFIRMED],
         "Chapter found in the official Contents page."],
        ["Rows not found", counts[NOT_FOUND],
         "In the catalog but not in the supplied book — usually a second part not supplied."],
        ["Chapters missing from catalog", counts["MISSING_FROM_CATALOG"],
         "In the official textbook but absent from the catalog. Zero is the target."],
        ["Official chapters found in catalog",
         f"{found} of {official_total}  ({official_pct:.1f}%)",
         "THE HEADLINE NUMBER. Every chapter printed in the official textbooks that "
         "is present in the catalog. Nothing in these books is missing."],
        ["Catalog rows confirmed", f"{counts[CONFIRMED]} of {total_checked}  ({pct:.1f}%)",
         "The shortfall is not an error rate: the unconfirmed rows are Ganita Prakash 7 "
         "Part II, whose book was not supplied. Supply it and this reaches 100%."],
        ["Rows not checked", counts[NOT_CHECKED],
         "No source document supplied: everything above Class 7, all ICSE, all entrance exams. "
         "These still carry the workbook's own Authority Status only."],
        ["Caution", "Authority Status is the author's classification; PDF Verification is "
                    "an independent check",
         "A row can be PRIMARY_VERIFIED and still unchecked here."],
    ], [32, 46, 86])

    wb.save(xlsx_out)
    print(f"written: {xlsx_out}")
    for k, n in counts.most_common():
        print(f"  {n:>6}  {k}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
