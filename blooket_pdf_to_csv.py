import re
import csv
import sys

import pymupdf


def gather_page_spans(page):
    spans = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if span["font"] in ("ArialMT", "TitanOne"):
                    continue
                if "Question Set" in span["text"] or "Answer Key" in span["text"]:
                    continue
                if not span["text"].strip():
                    continue
                spans.append(span)
    return spans


def order_spans(spans):
    spans = sorted(spans, key=lambda s: s["bbox"][1])
    rows = []
    cur = []
    for span in spans:
        if not cur or abs(span["bbox"][1] - cur[0]["bbox"][1]) <= 6:
            cur.append(span)
        else:
            rows.append(cur)
            cur = [span]
    if cur:
        rows.append(cur)
    ordered = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda s: s["bbox"][0]))
    return ordered


def extract(pdf_path):
    doc = pymupdf.open(pdf_path)
    qre = re.compile(r"^(\d{1,3})\.\s*(.*)$")
    ore = re.compile(r"^([a-e])\)\s*(.*)$")

    questions = []
    cur = None

    for pno in range(doc.page_count):
        for span in order_spans(gather_page_spans(doc[pno])):
            text = span["text"].strip()
            size = round(span["size"], 1)
            x0 = span["bbox"][0]
            col = "R" if x0 > 180 else "L"
            is_correct = span["font"] == "Type3 (7 0 R)"

            m = qre.match(text)
            if m and (cur is None or int(m.group(1)) == len(questions) + 1):
                cur = {"question": m.group(2).strip(), "options": [], "last": {}}
                questions.append(cur)
                continue

            m = ore.match(text)
            if m and cur is not None:
                opt = {"text": m.group(2).strip(), "correct": is_correct}
                cur["options"].append(opt)
                cur["last"][col] = opt
                continue

            if cur is None:
                continue
            if size > 12.5:
                cur["question"] = (cur["question"] + " " + text).strip()
            elif col in cur["last"]:
                opt = cur["last"][col]
                opt["text"] = (opt["text"] + " " + text).strip()

    return questions


def build_row(q):
    options = q["options"]
    corrects = [o for o in options if o["correct"]]
    primary = corrects[0] if corrects else (options[0] if options else {"text": ""})
    distractors = [o["text"] for o in options if o is not primary]
    while len(distractors) < 3:
        distractors.append("")
    return [q["question"], primary["text"]] + distractors[:3]


def write_csv(questions, out_path):
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(
            ["Question", "Correct Answer", "Incorrect Answer 1", "Incorrect Answer 2", "Incorrect Answer 3"]
        )
        for q in questions:
            writer.writerow(build_row(q))


def main():
    pdf = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\21Eri\Downloads\AI Builder Blooket _ Blooket.pdf"
    out = sys.argv[2] if len(sys.argv) > 2 else "AI Builder Blooket.csv"
    questions = extract(pdf)
    write_csv(questions, out)

    no_correct = [q["question"] for q in questions if not any(o["correct"] for o in q["options"])]
    bad_count = [(q["question"], len(q["options"])) for q in questions if len(q["options"]) != 4]
    print(f"Parsed {len(questions)} questions -> {out}")
    if no_correct:
        print("WARNING missing correct answer:", no_correct)
    if bad_count:
        print("WARNING option counts != 4:")
        for qtext, n in bad_count:
            print(f"   ({n}) {qtext}")


if __name__ == "__main__":
    main()
