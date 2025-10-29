#!/usr/bin/env python3
"""
merge_labels.py
Phase 2: Merge human labels back into model outputs

Takes review CSV with human labels and merges back into model_outputs.jsonl

Usage:
python merge_labels.py --model model_outputs.jsonl --review review_labeled.csv --out model_outputs_labeled.jsonl
"""
import argparse, json, csv
from collections import defaultdict

def load_review(review_csv):
    """Load review CSV and organize by question ID and claim index"""
    reviews = defaultdict(list)
    with open(review_csv, 'r') as f:
        reader = csv.DictReader(f)
        for r in reader:
            key = r['id']
            ci = r.get('claim_index', '')
            try:
                ci_int = int(ci) if ci != '' else None
            except:
                ci_int = None
            
            reviews[key].append({
                'claim_index': ci_int,
                'label_match': r.get('label_match', ''),
                'citations_ok': r.get('citations_ok', ''),
                'escalate_recommended': r.get('escalate_recommended', ''),
                'label_comment': r.get('label_comment', '')
            })
    return reviews

def merge(model_path, review_csv, out_path):
    """Merge human labels into model outputs"""
    reviews = load_review(review_csv)
    out_lines = []
    
    with open(model_path, 'r') as f:
        for line in f:
            if not line.strip(): continue
            obj = json.loads(line)
            qid = obj.get('id')
            
            # Get claims from model_raw
            model_raw = obj.get('model_raw', {})
            if isinstance(model_raw, dict) and 'rag' in model_raw:
                rag_data = model_raw['rag']
                model_claims = rag_data.get('claims', [])
                
                # Get reviews for this question
                revs = reviews.get(qid, [])
                
                # Map reviews by claim_index
                rev_map = {}
                for r in revs:
                    if r['claim_index'] is not None:
                        rev_map[r['claim_index']] = r
                    else:
                        # Overall row without claim_index: store as metadata
                        rev_map.setdefault('__meta__', []).append(r)
                
                # Merge labels into claims
                merged_claims = []
                for i, mc in enumerate(model_claims):
                    r = rev_map.get(i, {})
                    mc['label_match'] = r.get('label_match', '')
                    mc['citations_ok'] = r.get('citations_ok', '')
                    mc['escalate_recommended'] = r.get('escalate_recommended', '')
                    mc['label_comment'] = r.get('label_comment', '')
                    merged_claims.append(mc)
                
                # Update claims in model_raw
                rag_data['claims'] = merged_claims
                obj['model_raw']['rag'] = rag_data
                
                # Add metadata if present
                if '__meta__' in rev_map:
                    obj['review_meta'] = rev_map['__meta__']
            
            out_lines.append(obj)
    
    # Write labeled outputs
    with open(out_path, 'w') as fout:
        for o in out_lines:
            fout.write(json.dumps(o) + '\n')
    
    print(f"Wrote merged labeled model outputs to {out_path}")
    print(f"Total questions: {len(out_lines)}")
    print("\nNext step: Run claim-level evaluation:")
    print(f"python evaluate_claim_level.py --eval eval.jsonl --model_out {out_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='Original model_outputs.jsonl')
    parser.add_argument('--review', required=True, help='review_labeled.csv with human labels')
    parser.add_argument('--out', required=True, help='Output file with merged labels')
    args = parser.parse_args()
    merge(args.model, args.review, args.out)

