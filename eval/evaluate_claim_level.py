#!/usr/bin/env python3
"""
evaluate_claim_level.py
Phase 2: Claim-level evaluation with precision/recall/F1 metrics

Evaluates model claims against gold claims at granular level.
Detects hallucinations (claims without sources) and tracks critical claims.

Usage:
python evaluate_claim_level.py --eval eval.jsonl --model_out model_outputs.jsonl --threshold 0.6
"""
import argparse, json, csv
from difflib import SequenceMatcher
from collections import defaultdict

def normalize(s):
    if not s: return ""
    return " ".join(s.lower().strip().split())

def similarity(a, b):
    if not a or not b: return 0.0
    return SequenceMatcher(None, a, b).ratio()

def match_claims(model_claims, gold_claims, threshold=0.6):
    """
    Match model claims to gold claims using fuzzy matching.
    Returns: (matched_pairs, unmatched_model, unmatched_gold)
    """
    matched = []
    used_gold = set()
    used_model = set()
    
    # Try to match each model claim to a gold claim
    for mi, mc in enumerate(model_claims):
        mc_text = normalize(mc.get('text', ''))
        best_match = None
        best_score = 0.0
        
        for gi, gc in enumerate(gold_claims):
            if gi in used_gold:
                continue
            gc_text = normalize(gc.get('text', ''))
            score = similarity(mc_text, gc_text)
            if score > best_score and score >= threshold:
                best_score = score
                best_match = gi
        
        if best_match is not None:
            matched.append({
                'model_idx': mi,
                'gold_idx': best_match,
                'model_claim': mc,
                'gold_claim': gold_claims[best_match],
                'score': best_score
            })
            used_model.add(mi)
            used_gold.add(best_match)
    
    unmatched_model = [mc for i, mc in enumerate(model_claims) if i not in used_model]
    unmatched_gold = [gc for i, gc in enumerate(gold_claims) if i not in used_gold]
    
    return matched, unmatched_model, unmatched_gold

def evaluate(eval_path, model_out_path, sim_threshold=0.6, out_json='eval_results_claim.json', out_csv='eval_details_claim.csv'):
    # Load eval golds
    golds = {}
    with open(eval_path, 'r') as f:
        for ln in f:
            if not ln.strip(): continue
            obj = json.loads(ln)
            golds[obj['id']] = obj

    # Evaluate each case
    details = []
    totals = {
        'cases': 0,
        'tp': 0,  # true positives (matched claims)
        'fp': 0,  # false positives (hallucinations - unmatched model claims)
        'fn': 0,  # false negatives (missing gold claims)
        'critical_missing': 0,
        'unverified_claims': 0,
        'total_claims_extracted': 0,
        'total_gold_claims': 0
    }

    for ln in open(model_out_path, 'r'):
        if not ln.strip(): continue
        out = json.loads(ln)
        qid = out.get('id')
        gold = golds.get(qid, {})
        
        # Extract claims from model output
        model_raw = out.get('model_raw', {})
        rag_data = model_raw.get('rag', {}) if isinstance(model_raw, dict) else {}
        model_claims = rag_data.get('claims', [])
        
        gold_claims = gold.get('gold_claims', [])
        gold_critical_ids = {c.get('claim_id') for c in gold_claims if c.get('critical')}
        
        # Match claims
        matched, unmatched_model, unmatched_gold = match_claims(model_claims, gold_claims, sim_threshold)
        
        tp = len(matched)
        fp = len(unmatched_model)
        fn = len(unmatched_gold)
        
        # Check if critical claims are missing
        matched_gold_ids = {m['gold_claim'].get('claim_id') for m in matched}
        missing_critical = gold_critical_ids - matched_gold_ids
        
        # Count unverified claims (potential hallucinations)
        unverified_count = sum(1 for mc in model_claims if not mc.get('verified', True))
        
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        
        details.append({
            'id': qid,
            'question': out.get('question', ''),
            'total_model_claims': len(model_claims),
            'total_gold_claims': len(gold_claims),
            'matched_claims': tp,
            'hallucinations': fp,
            'missing_claims': fn,
            'unverified_claims': unverified_count,
            'critical_missing': len(missing_critical),
            'precision': precision,
            'recall': recall,
            'f1': f1,
            'use_rag': out.get('use_rag', False),
            'latency_ms': out.get('latency_ms'),
            'matched_details': [{'model': m['model_claim'].get('text'), 'gold': m['gold_claim'].get('text'), 'score': m['score']} for m in matched],
            'hallucinations_list': [mc.get('text') for mc in unmatched_model],
            'missing_list': [gc.get('text') for gc in unmatched_gold]
        })
        
        totals['cases'] += 1
        totals['tp'] += tp
        totals['fp'] += fp
        totals['fn'] += fn
        totals['critical_missing'] += 1 if len(missing_critical) > 0 else 0
        totals['unverified_claims'] += unverified_count
        totals['total_claims_extracted'] += len(model_claims)
        totals['total_gold_claims'] += len(gold_claims)
    
    # Compute summary
    total_tp = totals['tp']
    total_fp = totals['fp']
    total_fn = totals['fn']
    
    summary = {
        'cases': totals['cases'],
        'precision': total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0.0,
        'recall': total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0.0,
        'f1': 0.0,
        'hallucination_rate': total_fp / totals['total_claims_extracted'] if totals['total_claims_extracted'] > 0 else 0.0,
        'critical_fail_rate': totals['critical_missing'] / totals['cases'] if totals['cases'] > 0 else 0.0,
        'unverified_rate': totals['unverified_claims'] / totals['total_claims_extracted'] if totals['total_claims_extracted'] > 0 else 0.0,
        'avg_claims_per_answer': totals['total_claims_extracted'] / totals['cases'] if totals['cases'] > 0 else 0.0,
        'avg_latency_ms': sum(d.get('latency_ms') or 0 for d in details) / totals['cases'] if totals['cases'] > 0 else None
    }
    
    # Calculate F1
    if (summary['precision'] + summary['recall']) > 0:
        summary['f1'] = 2 * summary['precision'] * summary['recall'] / (summary['precision'] + summary['recall'])
    
    # Write outputs
    with open(out_json, 'w') as jf:
        json.dump({'summary': summary, 'details': details}, jf, indent=2)
    
    # Write CSV
    csv_rows = []
    for d in details:
        csv_rows.append({
            'id': d['id'],
            'question': d['question'][:100],
            'model_claims': d['total_model_claims'],
            'gold_claims': d['total_gold_claims'],
            'matched': d['matched_claims'],
            'hallucinations': d['hallucinations'],
            'missing': d['missing_claims'],
            'unverified': d['unverified_claims'],
            'critical_missing': d['critical_missing'],
            'precision': f"{d['precision']:.2f}",
            'recall': f"{d['recall']:.2f}",
            'f1': f"{d['f1']:.2f}",
            'latency_ms': d['latency_ms']
        })
    
    with open(out_csv, 'w', newline='') as cf:
        if csv_rows:
            writer = csv.DictWriter(cf, fieldnames=list(csv_rows[0].keys()))
            writer.writeheader()
            for r in csv_rows:
                writer.writerow(r)
    
    print("Wrote", out_json, "and", out_csv)
    print("\nSummary:")
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--eval', required=True)
    parser.add_argument('--model_out', required=True)
    parser.add_argument('--threshold', type=float, default=0.6)
    parser.add_argument('--out_json', default='eval_results_claim.json')
    parser.add_argument('--out_csv', default='eval_details_claim.csv')
    args = parser.parse_args()
    evaluate(args.eval, args.model_out, args.threshold, args.out_json, args.out_csv)

