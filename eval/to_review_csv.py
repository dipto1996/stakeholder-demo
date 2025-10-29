#!/usr/bin/env python3
"""
to_review_csv.py
Phase 2: Generate CSV for human review of claims

Converts model_outputs.jsonl → review.csv (one row per model claim)
Reviewers mark each claim as correct/incorrect in Google Sheets

Usage:
python to_review_csv.py --model model_outputs.jsonl --out review.csv
"""
import argparse, json, csv
from pathlib import Path

def to_csv(model_path, out_csv):
    rows = []
    with open(model_path, 'r') as f:
        for line in f:
            if not line.strip(): continue
            obj = json.loads(line)
            
            qid = obj.get('id')
            question = obj.get('question', '')
            
            # Extract answer and claims from model response
            model_raw = obj.get('model_raw', {})
            rag_data = model_raw.get('rag', {}) if isinstance(model_raw, dict) else {}
            
            short_answer = obj.get('short_answer', '') or rag_data.get('answer', '')
            sources = rag_data.get('sources', [])
            claims = rag_data.get('claims', [])
            use_rag = obj.get('use_rag', False)
            
            if not claims:
                # No claims extracted - create placeholder row for overall answer review
                rows.append({
                    'id': qid,
                    'question': question[:200],
                    'short_answer': short_answer[:500],
                    'claim_index': '',
                    'claim_text': '',
                    'claim_verified': '',
                    'claim_critical': '',
                    'source_title': (sources[0]['title'] if sources else ''),
                    'source_url': (sources[0]['url'] if sources else ''),
                    'use_rag': 'yes' if use_rag else 'no',
                    'label_match': '',  # Reviewer fills: yes/no/partial
                    'label_comment': '',
                    'citations_ok': '',  # Reviewer fills: yes/no
                    'escalate_recommended': ''  # Reviewer fills: yes/no
                })
            else:
                # Create one row per claim
                for i, claim in enumerate(claims):
                    claim_source = claim.get('source', {})
                    rows.append({
                        'id': qid,
                        'question': question[:200],
                        'short_answer': short_answer[:500],
                        'claim_index': i,
                        'claim_text': claim.get('text', ''),
                        'claim_verified': 'yes' if claim.get('verified', False) else 'no',
                        'claim_critical': 'yes' if claim.get('critical', False) else 'no',
                        'source_title': claim_source.get('title', '') if claim_source else '',
                        'source_url': claim_source.get('url', '') if claim_source else '',
                        'use_rag': 'yes' if use_rag else 'no',
                        'label_match': '',  # Reviewer fills: yes/no/partial
                        'label_comment': '',
                        'citations_ok': '' if claim_source else 'no',  # Pre-fill if no source
                        'escalate_recommended': ''
                    })
    
    # Write CSV
    if not rows:
        print("No data to write!")
        return
    
    with open(out_csv, 'w', newline='') as csvfile:
        fieldnames = list(rows[0].keys())
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)
    
    print(f"Wrote review CSV: {out_csv}")
    print(f"Total rows: {len(rows)}")
    print(f"\nInstructions for reviewers:")
    print("1. Open review.csv in Google Sheets")
    print("2. For each claim, fill:")
    print("   - label_match: 'yes' (correct), 'no' (wrong), 'partial' (partially correct)")
    print("   - label_comment: Any notes or corrections")
    print("   - citations_ok: 'yes' if source is appropriate, 'no' if wrong/missing")
    print("   - escalate_recommended: 'yes' if claim needs attorney review")
    print("3. Save and download as review_labeled.csv")
    print("4. Run: python merge_labels.py --model model_outputs.jsonl --review review_labeled.csv --out model_outputs_labeled.jsonl")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='model_outputs.jsonl file')
    parser.add_argument('--out', required=True, help='Output CSV file for human review')
    args = parser.parse_args()
    to_csv(args.model, args.out)

