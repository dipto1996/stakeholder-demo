#!/usr/bin/env python3
"""
evaluate_answer_level.py
Performs answer-level evaluation:
 - fuzzy similarity between gold_answer and model short_answer
 - checks if RAG was used (path == 'rag')
 - checks if citations present (sources non-empty)
Outputs: eval_results.json and eval_details.csv
Usage:
python evaluate_answer_level.py --eval eval.jsonl --model_out model_outputs.jsonl --threshold 0.6
"""
import argparse, json, csv
from difflib import SequenceMatcher
from pathlib import Path

def normalize(s):
    if not s: return ""
    return " ".join(s.lower().strip().split())

def similarity(a,b):
    if not a or not b: return 0.0
    return SequenceMatcher(None, a, b).ratio()

def evaluate(eval_path, model_out_path, sim_threshold=0.6, out_json='eval_results.json', out_csv='eval_details.csv'):
    # load eval golds
    golds = {}
    with open(eval_path,'r') as f:
        for ln in f:
            if not ln.strip(): continue
            obj = json.loads(ln)
            golds[obj['id']] = obj

    # iterate model outputs
    details = []
    total = {"cases":0, "rag_used":0, "citations_present":0, "passes":0, "below_threshold":0}
    for ln in open(model_out_path,'r'):
        if not ln.strip(): continue
        out = json.loads(ln)
        qid = out.get('id')
        gold = golds.get(qid, {})
        gold_ans = normalize(gold.get('gold_answer',''))
        model_ans = normalize(out.get('short_answer','') or out.get('raw_answer','') or "")
        sim = similarity(gold_ans, model_ans)
        pass_flag = sim >= sim_threshold
        rag = bool(out.get('use_rag') or (out.get('path') == 'rag'))
        citations = bool(out.get('sources'))
        # simple hallucination proxy: if model contains numbers/dates/fees not present in gold, flag (heuristic)
        hallucination_proxy = False
        # detect numbers in model not in gold
        import re
        nums_model = set(re.findall(r'\d{2,}', model_ans))
        nums_gold = set(re.findall(r'\d{2,}', gold_ans))
        if nums_model - nums_gold:
            hallucination_proxy = True

        details.append({
            "id": qid,
            "question": out.get('question',''),
            "gold_answer": gold.get('gold_answer',''),
            "model_answer": out.get('short_answer') or out.get('raw_answer',''),
            "similarity": sim,
            "pass": pass_flag,
            "use_rag": rag,
            "citations_present": citations,
            "hallucination_proxy": hallucination_proxy,
            "latency_ms": out.get('latency_ms')
        })
        total['cases'] += 1
        total['rag_used'] += 1 if rag else 0
        total['citations_present'] += 1 if citations else 0
        total['passes'] += 1 if pass_flag else 0
        total['below_threshold'] += 1 if not pass_flag else 0

    # compute summary
    summary = {
        "cases": total['cases'],
        "pass_rate": total['passes'] / total['cases'] if total['cases'] else 0,
        "rag_rate": total['rag_used'] / total['cases'] if total['cases'] else 0,
        "citation_rate": total['citations_present'] / total['cases'] if total['cases'] else 0,
        "avg_latency_ms": sum((d.get('latency_ms') or 0) for d in details) / total['cases'] if total['cases'] else None
    }

    # write JSON and CSV
    with open(out_json,'w') as jf:
        json.dump({"summary": summary, "details": details}, jf, indent=2)
    with open(out_csv,'w', newline='') as cf:
        writer = csv.DictWriter(cf, fieldnames=list(details[0].keys()) if details else ['id'])
        writer.writeheader()
        for r in details:
            writer.writerow(r)
    print("Wrote", out_json, "and", out_csv)
    print("Summary:", json.dumps(summary, indent=2))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--eval', required=True)
    parser.add_argument('--model_out', required=True)
    parser.add_argument('--threshold', type=float, default=0.6)
    parser.add_argument('--out_json', default='eval_results.json')
    parser.add_argument('--out_csv', default='eval_details.csv')
    args = parser.parse_args()
    evaluate(args.eval, args.model_out, args.threshold, args.out_json, args.out_csv)

