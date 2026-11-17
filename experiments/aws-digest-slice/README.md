# AWS-shaped digest slice

This folder keeps the golden-set eval of the scheduled rule digestion and the first
least-privilege Terraform sketch. The handler, the raw-output store and the replay
client that started here moved to production code in issue 93: `src/aws/` holds the
plan and read handlers, and `cli.ts` drives the production read handler against the
recorded outputs. It runs locally and for free. Nothing here is deployed.

```bash
npx tsx --test "src/aws/*.test.ts"
python3 experiments/aws-digest-slice/eval_golden.py --min-recall 0.8 --max-fpr 0.5
docker run --rm -v "$PWD/experiments/aws-digest-slice/terraform":/w -w /w hashicorp/terraform:1.9.8 init -backend=false
docker run --rm -v "$PWD/experiments/aws-digest-slice/terraform":/w -w /w hashicorp/terraform:1.9.8 validate
```

- **Replay by default.** `recorded-outputs.json` holds the stored `deepseek-v4-flash`
  prompt `v4` readings of these rules, so the eval costs nothing and repeats exactly. It
  measures that model and prompt. A new one needs new recordings.
- **The model investigates; code decides.** `runDigest`/`parseDigest` (production code,
  not a copy) reject bad schema, closed-list violations and outcome opinions. They also
  prune any trap whose quoted passage is not in the rule. The read handler adds a
  deadline, reason codes, one JSON log line per call, the raw output of every call, and a
  write only on a valid reading.
- **The injection case** has a synthetic rule and a hand-written output that obeys it. It
  tests the code guard, not a model. The guard does not stop a model that quotes the
  injected sentence itself, because that passage is in the rule.
- **Result (n=10, 2026-11-16):** recall 1.00, FPR 0.50, precision 0.75. The model
  over-flags: in 266 of 267 stored rule texts at least one reading has a trap marked
  `muda_resultado`. One item moves a rate by 12 to 25 points.
- **Cost warning.** `terraform apply` creates billable resources. It has not been run.
  The Terraform tutorial's `apply` also launches an EC2 instance.
- **What production still needs after issue 93:** the DynamoDB adapter, the esbuild
  bundle (`npm run build:lambda`) and the handlers are in `src/aws/`. Still missing:
  - Step Functions with Retry on throttling and Catch to a dead-letter queue (PR 3 of
    issue 86);
  - an alarm on FPR and `SCHEMA_INVALID` rate;
  - a larger golden set reviewed by a second person.
