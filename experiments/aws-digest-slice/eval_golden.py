"""Golden-set eval for the rule-digest slice. Python standard library only.

Runs every labeled rule through the handler (cli.ts, replay client, no paid
call) and grades the answer by code:

- prediction: the rule "has a trap" when at least one finding with severity
  muda_resultado (changes the outcome) survives the guard;
- a positive counts as TP only if one surviving finding quotes a passage that
  overlaps an expected passage. Right answer, wrong reason is an FN.

    python3 experiments/aws-digest-slice/eval_golden.py --min-recall 0.8 --max-fpr 0.5

Exits 1 when recall is below --min-recall or FPR is above --max-fpr, so it can
gate CI. n is small: one item moves a rate by 10 points or more.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CLI = HERE / "cli.ts"


def normalize(text):
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


def overlaps(found, expected):
    a, b = normalize(found), normalize(expected)
    return len(a) >= 10 and (b in a or a in b)


def run_handler(item):
    payload = json.dumps({"rule_text": item["rule_text"], "headline": item["headline"]})
    done = subprocess.run(
        ["npx", "tsx", str(CLI)],
        input=payload,
        capture_output=True,
        text=True,
        cwd=REPO,
        check=True,
    )
    return json.loads(done.stdout)


def grade(item, response):
    expected = item["expected"]
    decisive = [
        f for f in response["findings"]
        if f["severidade"] == "muda_resultado" and f["trecho"]
    ]
    predicted = response["reason"] == "OK" and len(decisive) > 0
    if expected["has_trap"]:
        hit = any(overlaps(f["trecho"], p) for f in decisive for p in expected["passages"])
        return "TP" if predicted and hit else "FN"
    return "FP" if predicted else "TN"


def rate(num, den):
    return None if den == 0 else num / den


def fmt(value):
    return "n/a" if value is None else f"{value:.2f}"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--golden", default=str(HERE / "golden-rules.json"))
    parser.add_argument("--min-recall", type=float, default=None)
    parser.add_argument("--max-fpr", type=float, default=None)
    parser.add_argument(
        "--judge",
        action="store_true",
        help="LLM-as-judge grading. Not implemented: it would call a paid model.",
    )
    args = parser.parse_args()

    if args.judge:
        print("--judge is a stub: an LLM judge calls a paid model and needs its own "
              "calibration set. Grading here is by code only.", file=sys.stderr)
        return 2

    golden = json.loads(Path(args.golden).read_text(encoding="utf-8"))
    counts = {"TP": 0, "FP": 0, "FN": 0, "TN": 0}

    print(f"{'item':<28} {'expected':<9} {'reason':<15} {'kept':>4} {'pruned':>6}  outcome")
    for item in golden:
        response = run_handler(item)
        outcome = grade(item, response)
        counts[outcome] += 1
        expected = "trap" if item["expected"]["has_trap"] else "clean"
        print(f"{item['id']:<28} {expected:<9} {response['reason']:<15} "
              f"{len(response['findings']):>4} {response['pruned']:>6}  {outcome}")

    tp, fp, fn, tn = counts["TP"], counts["FP"], counts["FN"], counts["TN"]
    precision = rate(tp, tp + fp)
    recall = rate(tp, tp + fn)
    fpr = rate(fp, fp + tn)

    print()
    print(f"n={len(golden)}  TP={tp} FP={fp} FN={fn} TN={tn}")
    print(f"precision={fmt(precision)}  recall={fmt(recall)}  fpr={fmt(fpr)}")

    failed = []
    if args.min_recall is not None and (recall is None or recall < args.min_recall):
        failed.append(f"recall {fmt(recall)} < {args.min_recall}")
    if args.max_fpr is not None and (fpr is None or fpr > args.max_fpr):
        failed.append(f"fpr {fmt(fpr)} > {args.max_fpr}")
    if failed:
        print("GATE FAILED: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
