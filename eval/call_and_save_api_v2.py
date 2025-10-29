#!/usr/bin/env python3
"""
call_and_save_api_v2.py
Call your chat endpoint for each eval.jsonl question and save normalized outputs to model_outputs.jsonl
Adapted for API responses like:
 - { "rag": { "answer": "...", "sources":[{id,title,url,excerpt}]}, "path":"rag" }
 - { "answer": "...", "sources":[...], "path":"fallback" }

Usage:
python call_and_save_api_v2.py --eval eval.jsonl --out model_outputs.jsonl --endpoint https://your-staging-endpoint/chat
"""
import argparse, json, time, requests, os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

def call_endpoint(endpoint, payload, headers=None, timeout=60):
    try:
        t0 = time.time()
        r = requests.post(endpoint, json=payload, headers=headers, timeout=timeout)
        elapsed = (time.time() - t0) * 1000.0
        r.raise_for_status()
        return r.json(), elapsed
    except Exception as e:
        return {"error": str(e)}, None

def normalize_response(resp, latency_ms):
    # resp may contain "rag" or "answer" top-level; normalize to schema
    normalized = {
        "raw": resp,
        "raw_error": None,
        "raw_answer": None,
        "short_answer": None,
        "sources": [],
        "path": resp.get("path") if isinstance(resp, dict) else None,
        "use_rag": False,
        "latency_ms": latency_ms
    }
    if not isinstance(resp, dict):
        normalized["raw_error"] = "non-dict response"
        return normalized

    # RAG path shape
    if "rag" in resp and isinstance(resp["rag"], dict):
        rag = resp["rag"]
        ans = rag.get("answer") or rag.get("text") or ""
        normalized["raw_answer"] = ans
        normalized["short_answer"] = ans.strip()
        normalized["sources"] = rag.get("sources", [])
        normalized["use_rag"] = True
        normalized["path"] = resp.get("path","rag")
        return normalized

    # fallback or other shapes
    if "answer" in resp:
        normalized["raw_answer"] = resp.get("answer")
        normalized["short_answer"] = resp.get("answer","").strip()
        normalized["sources"] = resp.get("sources", [])
        normalized["use_rag"] = bool(resp.get("path") == "rag")
        normalized["path"] = resp.get("path", "fallback")
        return normalized

    # If the provider nested content differently (e.g., data.choices...), do a best-effort find
    # Try some common shapes:
    if "data" in resp and isinstance(resp["data"], list):
        # example: data[0].content
        try:
            first = resp["data"][0]
            if isinstance(first, dict):
                txt = first.get("content") or first.get("text") or ""
                normalized["raw_answer"] = txt
                normalized["short_answer"] = txt.strip()
                normalized["sources"] = resp.get("sources", [])
                normalized["path"] = resp.get("path","unknown")
                return normalized
        except Exception:
            pass

    # If nothing matched
    normalized["raw_error"] = "unrecognized_response_shape"
    return normalized

def main(eval_path, out_path, endpoint, api_key_env=None, sleep=0.1):
    headers = {}
    if api_key_env:
        key = os.getenv(api_key_env)
        if key:
            headers["Authorization"] = f"Bearer {key}"
    eval_items = []
    with open(eval_path,'r') as f:
        for ln in f:
            if not ln.strip(): continue
            eval_items.append(json.loads(ln))
    out_file = Path(out_path)
    with out_file.open('w') as fout:
        for item in eval_items:
            qid = item.get("id")
            question = item.get("question")
            payload = {
                "messages": [
                    {"role": "user", "content": question}
                ],
                "meta": {"eval_id": qid}
            }
            print(f"Calling {qid} ...")
            resp, latency = call_endpoint(endpoint, payload, headers=headers)
            norm = normalize_response(resp, latency)
            # include question and gold reference for traceability
            model_out = {
                "id": qid,
                "question": question,
                "gold_answer": item.get("gold_answer",""),
                "model_raw": norm["raw"],
                "raw_error": norm["raw_error"],
                "raw_answer": norm["raw_answer"],
                "short_answer": norm["short_answer"],
                "sources": norm["sources"],
                "path": norm["path"],
                "use_rag": norm["use_rag"],
                "latency_ms": norm["latency_ms"],
                "timestamp": int(time.time())
            }
            fout.write(json.dumps(model_out) + "\n")
            fout.flush()
            time.sleep(sleep)
    print("Saved model outputs to", out_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--eval', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--api_key_env', default=None)
    args = parser.parse_args()
    main(args.eval, args.out, args.endpoint, api_key_env=args.api_key_env)

