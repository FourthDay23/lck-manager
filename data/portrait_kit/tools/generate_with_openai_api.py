"""Generate the portrait-kit images with the OpenAI Images API, for an agent that has no built-in image tool.

  pip install openai pillow
  (set OPENAI_API_KEY in the environment; never write the key into a file)
  python tools/generate_with_openai_api.py --kit . --dry-run          list what would be generated
  python tools/generate_with_openai_api.py --kit . --step 1           style_ref only (show it to the user first)
  python tools/generate_with_openai_api.py --kit . --step 2           the five outfit templates
  python tools/generate_with_openai_api.py --kit . --step 3           all face batches
  python tools/generate_with_openai_api.py --kit . --only "1_LCK/01_T1/batch1" --force   redo one job

Jobs come from prompts/jobs.json: {"id", "step", "prompt", "attachments" (in order), "output", "size"}.
A job whose output already exists is skipped (unless --force); a job whose attachments are not there yet
(for example style_ref before step 1) is skipped and reported. The reference photos are sent as input images
to the image edit endpoint in the listed order.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kit", type=Path, default=Path(__file__).resolve().parent.parent, help="kit root folder")
    ap.add_argument("--jobs", type=Path, help="jobs file (default <kit>/prompts/jobs.json)")
    ap.add_argument("--step", type=int, choices=[1, 2, 3])
    ap.add_argument("--only", help="one job id")
    ap.add_argument("--model", default="gpt-image-1")
    ap.add_argument("--quality", default="high", choices=["low", "medium", "high", "auto"])
    ap.add_argument("--force", action="store_true", help="regenerate even if the output exists")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    a = ap.parse_args()
    kit = a.kit.resolve()
    jobs = json.loads((a.jobs or kit / "prompts" / "jobs.json").read_text(encoding="utf-8"))
    jobs = [j for j in jobs if (a.step is None or j["step"] == a.step) and (a.only is None or j["id"] == a.only)]
    if not jobs:
        sys.exit("no job matches")

    client = None
    if not a.dry_run:
        from openai import OpenAI  # reads OPENAI_API_KEY from the environment
        client = OpenAI()

    made = skipped = waiting = failed = 0
    for job in jobs:
        out = kit / job["output"]
        if out.exists() and not a.force:
            skipped += 1
            continue
        missing = [p for p in job["attachments"] if not (kit / p).exists()]
        if missing:
            waiting += 1
            print(f"wait  {job['id']}: missing {', '.join(missing)}")
            continue
        if a.dry_run:
            print(f"plan  {job['id']} -> {job['output']} ({job['size']}, {len(job['attachments'])} images)")
            continue
        for attempt in range(1, 4):
            files = [open(kit / p, "rb") for p in job["attachments"]]
            try:
                result = client.images.edit(model=a.model, image=files, prompt=job["prompt"], size=job["size"],
                                            quality=a.quality, n=1)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(base64.b64decode(result.data[0].b64_json))
                made += 1
                print(f"done  {job['id']} -> {job['output']}")
                break
            except Exception as error:  # refusals, rate limits, network
                print(f"retry {job['id']} ({attempt}/3): {type(error).__name__}: {str(error)[:200]}")
                if attempt == 3:
                    failed += 1
                time.sleep(10 * attempt)
            finally:
                for f in files:
                    f.close()
        time.sleep(a.pause)
    print(f"made {made}, already there {skipped}, waiting for inputs {waiting}, failed {failed}")


if __name__ == "__main__":
    main()
