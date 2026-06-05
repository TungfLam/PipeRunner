#!/usr/bin/env python3
import argparse
import os
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    print(f"transcribing {args.input} with language={args.language}", flush=True)
    if not os.path.exists(args.input):
        raise SystemExit(f"input does not exist: {args.input}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    for step in range(1, 4):
        print(f"mock transcription chunk {step}/3", flush=True)
        time.sleep(0.25)

    with open(args.output, "w", encoding="utf-8") as file:
        file.write("1\n")
        file.write("00:00:00,000 --> 00:00:01,000\n")
        file.write(f"Mock transcript generated from {os.path.basename(args.input)} in {args.language}.\n")

    print(f"wrote subtitle: {args.output}", flush=True)


if __name__ == "__main__":
    main()
