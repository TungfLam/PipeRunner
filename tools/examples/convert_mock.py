#!/usr/bin/env python3
import argparse
import json
import os
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metadata")
    args = parser.parse_args()

    print(f"converting {args.input}", flush=True)
    if not os.path.exists(args.input):
        raise SystemExit(f"input does not exist: {args.input}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.input, "r", encoding="utf-8", errors="replace") as file:
        source = file.read()

    time.sleep(0.3)
    with open(args.output, "w", encoding="utf-8") as file:
        file.write("Workflow summary\n")
        file.write("================\n\n")
        file.write(source)

    if args.metadata:
        os.makedirs(os.path.dirname(args.metadata), exist_ok=True)
        with open(args.metadata, "w", encoding="utf-8") as file:
            json.dump(
                {
                    "input": args.input,
                    "output": args.output,
                    "characters": len(source),
                    "status": "ok"
                },
                file,
                indent=2,
            )

    print(f"wrote result: {args.output}", flush=True)
    if args.metadata:
        print(f"wrote metadata: {args.metadata}", flush=True)


if __name__ == "__main__":
    main()
