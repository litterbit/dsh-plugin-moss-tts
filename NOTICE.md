# NOTICE

DSH MOSS-TTS plugin (`dsh-plugin-moss-tts`)
Copyright (c) 2026 litterbit and contributors

Licensed under the Apache License, Version 2.0 — see `LICENSE`.

## What this package contains

This package contains **no model weights and no engine binaries**. It is a thin
DeepSeek Harness integration: it downloads the separately published MOSS-TTS CPU
engine at runtime, keeps it under `%LOCALAPPDATA%\MossTTS`, and starts it as a
child process over a stdin/stdout JSON protocol.

## Third-party components fetched at runtime

1. Engine — `MossTTS-win-x64-full.zip` from
   <https://github.com/litterbit/dsh-moss-tts/releases>, Apache License 2.0,
   verified against the release's `sha256sums.txt` before use.
2. Model weights and voice archives inside that archive are derived from
   MOSS-TTS-Nano-100M (<https://huggingface.co/>), Apache License 2.0. They are
   redistributed unmodified in structure and converted to the engine's container
   format (int8 Q8_0 4x4 LLM weights, fp16 decoder/encoder). No retraining of
   the model, its data or its parameters is involved.

This project is not affiliated with, or endorsed by, the authors of MOSS-TTS.
