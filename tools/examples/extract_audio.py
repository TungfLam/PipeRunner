#!/usr/bin/env python3
import argparse
import math
import os
import struct
import time
import wave


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    print(f"reading input: {args.input}", flush=True)
    if not os.path.exists(args.input):
        raise SystemExit(f"input does not exist: {args.input}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    sample_rate = 16000
    duration_seconds = 1.0
    frequency = 440.0
    amplitude = 12000

    with wave.open(args.output, "w") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for index in range(int(sample_rate * duration_seconds)):
            value = int(amplitude * math.sin(2 * math.pi * frequency * index / sample_rate))
            wav.writeframes(struct.pack("<h", value))

    time.sleep(0.4)
    print(f"wrote mock audio: {args.output}", flush=True)


if __name__ == "__main__":
    main()
