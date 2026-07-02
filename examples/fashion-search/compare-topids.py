#!/usr/bin/env python3
"""Diff per-query topIds between the tier0post artifact and the new p0honesty artifact.
Identical topIds across all queries proves retrieval is exactly flat, independent of the
judge/rubric change."""
import json, sys, glob

base = json.load(open("evals/runs/2026-07-02T07-47-08-993Z-search-tier0post.json"))
new_path = sorted(glob.glob("evals/runs/*-search-p0honesty.json"))[-1]
new = json.load(open(new_path))

base_by_q = {p["q"]: p for p in base["perQuery"]}
new_by_q = {p["q"]: p for p in new["perQuery"]}

same, diff, missing = 0, [], []
for q, bp in base_by_q.items():
    np_ = new_by_q.get(q)
    if np_ is None:
        missing.append(q)
        continue
    if bp["topIds"] == np_["topIds"]:
        same += 1
    else:
        diff.append((q, bp["topIds"], np_["topIds"]))

print(f"artifact: {new_path}")
print(f"queries: {len(base_by_q)}  identical topIds: {same}  changed: {len(diff)}  missing: {len(missing)}")
for q, b, n in diff:
    print(f"  CHANGED {q!r}\n    old: {b}\n    new: {n}")
for q in missing:
    print(f"  MISSING {q!r}")
print()
print("old overall:", base["overall"])
print("new overall:", new["overall"])
