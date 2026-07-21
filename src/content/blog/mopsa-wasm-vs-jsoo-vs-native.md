---
title: "MOPSA on wasm vs js_of_ocaml vs native: a performance comparison"
description: "Interpreting bytecode on a wasm-compiled runtime, compiling OCaml to JavaScript with js_of_ocaml, and running native code. What each costs, and where the wasm build quietly wins."
pubDate: 2026-07-15
draft: true
tags: ["mopsa", "webassembly", "ocaml", "js_of_ocaml", "performance"]
---

In a [previous post](/blog/running-mopsa-in-the-browser) I described how I compiled MOPSA, a static analyzer written mostly in OCaml on top of a stack of native C/C++ libraries (GMP, MPFR, Apron, LLVM/Clang), to WebAssembly. Rather than translating the OCaml code, that build compiles the OCaml **bytecode interpreter** plus the whole native stack to wasm with Emscripten, and interprets the unmodified `mopsa.bc` on top.

The obvious question is: **what does that cost?** Interpreting bytecode is not free, and there is already a browser build of MOPSA that takes the more conventional route. [Try-MOPSA](https://arxiv.org/abs/2509.13128) compiles the OCaml to JavaScript with `js_of_ocaml`. So there are three ways to run MOPSA to compare:

- **native** — the reference. `ocamlopt`-compiled machine code, doesn't run in a browser. This is the ceiling.
- **wasm** — my build. OCaml bytecode interpreted on an Emscripten-compiled runtime + native stack, one static `.wasm`.
- **jsoo** — Try-MOPSA. OCaml compiled ahead-of-time to JavaScript.

Both wasm and jsoo run in Node *and* in a headless browser, so there are really five configurations.

## The capability gap comes first

Before any timing, there is a difference that no benchmark captures: **jsoo cannot analyze C at all.**

`js_of_ocaml` translates only the OCaml. It leaves the C and C++ behind, so Try-MOPSA cannot carry MOPSA's native dependencies. It has no C frontend (that lives in the 5000-line `Clang_to_ml.cc`, which needs LLVM/Clang), and for its relational numerical domain it swaps the native Apron for [VPL](https://github.com/VERIMAG-Polyhedra/VPL), a pure-OCaml polyhedra library. The wasm build, because it drags the entire native stack across the boundary, runs the full C + Apron workload.

So the comparison below is only fair on the files **both** can run: the `universal` and `python` corpus. On C, wasm is compared against native alone, because jsoo simply isn't in the race.

## Method

The corpus is 14 files (4 `universal`, 5 `python`, 5 `c`), each analyzed **100 times** per configuration. The medians are reported. The raw JSON is the source of truth; everything below is derived from it.

All timings were collected on the same machine: an **AMD Ryzen AI 5 340** (6 cores / 12 threads) with 64 GB of RAM, running **Arch Linux** (Linux 7.1.3), under **Node.js 20.19.6** (V8 11.3) and **headless Chromium 150**.

Four things get measured separately, because they behave very differently:

- **instantiation** — getting the runtime ready *before* any analysis. For wasm: compile + instantiate the module and unpack the preloaded data. For jsoo: parse the ~22 MB JavaScript bundle. Zero for native.
- **cold run** — the first analysis, while V8 is still running the wasm/JS through its fast baseline compiler (Liftoff). This is what a one-shot CLI invocation sees.
- **warm run** — later analyses, once V8 has re-compiled the hot code with its optimizing tier (TurboFan). This is the steady state of a long-lived tab or server.
- **RSS** — peak resident memory.

One subtlety drives the whole result: **each analysis needs a fresh OCaml state.** The runtime is not re-entrant and `mopsa.bc` ends with `exit`, so you cannot reuse an instance. How each backend obtains that fresh state is where they diverge, as we'll see.

## Native vs wasm: the interpretation tax

Interpreting bytecode on wasm is, unsurprisingly, slower than native machine code. Once warm:

| file (python) | native | wasm warm | slowdown |
| --- | --- | --- | --- |
| `list_tests.py` | 26 ms | 250 ms | 9.6× |
| `class_tests.py` | 19 ms | 114 ms | 6.1× |
| `exception_tests.py` | 15 ms | 120 ms | 8.0× |
| `generator_tests.py` | 14 ms | 114 ms | 8.1× |
| `misc_tests.py` | 12 ms | 123 ms | 10.2× |

| file (c) | native | wasm warm | slowdown |
| --- | --- | --- | --- |
| `int_tests.c` | 19 ms | 189 ms | 10.0× |
| `array_tests.c` | 20 ms | 185 ms | 9.2× |
| `struct_tests.c` | 197 ms | 1585 ms | 8.1× |
| `function_tests.c` | 18 ms | 163 ms | 9.1× |
| `pointer_tests.c` | 24 ms | 224 ms | 9.3× |

So **roughly 8–10× slower than native** on real work, warm. That's the combined price of interpreting bytecode *and* running that interpreter itself as wasm rather than machine code — and it's a very reasonable number for a browser-hosted analyzer. (`struct_tests.c` is a pathological file that even native takes 197 ms on; the ratio holds regardless.)

Two caveats:

- **Cold is much worse** — 15× to 44× native — because the first run hits the Liftoff-compiled interpreter before V8 promotes it. A one-shot CLI feels this; a long-lived session doesn't.
- **Tiny files exaggerate the ratio.** The `universal` files are 1–2 ms native but ~20 ms wasm warm (up to 20×), because a fixed per-run interpreter overhead dominates when there's almost no work to do. The ratio shrinks as the analysis gets heavier, which is exactly what the python/C numbers show.

## wasm vs jsoo: it depends entirely on cold vs warm

This is the interesting one, because the two make opposite trade-offs.

**On a single cold run, jsoo is faster.** AOT-compiled JavaScript starts doing useful work immediately, while the wasm interpreter is still cold:

| file | wasm cold | jsoo | wasm/jsoo |
| --- | --- | --- | --- |
| `list_tests.py` | 535 ms | 403 ms | 1.33× |
| `class_tests.py` | 231 ms | 193 ms | 1.20× |
| `exception_tests.py` | 234 ms | 173 ms | 1.36× |
| `generator_tests.py` | 267 ms | 192 ms | 1.39× |
| `misc_tests.py` | 243 ms | 172 ms | 1.41× |

**But once warm, wasm pulls ahead** — and this is where the "fresh state per analysis" constraint decides everything:

| file | wasm warm | jsoo | jsoo/wasm |
| --- | --- | --- | --- |
| `list_tests.py` | 250 ms | 403 ms | 1.61× |
| `class_tests.py` | 114 ms | 193 ms | 1.70× |
| `exception_tests.py` | 120 ms | 173 ms | 1.44× |
| `generator_tests.py` | 114 ms | 192 ms | 1.69× |
| `misc_tests.py` | 123 ms | 172 ms | 1.40× |

Why does jsoo have no "warm" column that helps it? Because **a fresh OCaml state and a warm JIT are, for jsoo, mutually exclusive.** `js_of_ocaml` keeps the program's state and its code in one JavaScript realm (the global environment). Getting a clean state back means recreating that realm from scratch — and that throws away everything V8 had optimized, so the next analysis pays the JIT warm-up again. jsoo is effectively *always cold*.

The wasm build separates the two. The runtime state lives in a wasm instance that is cheap to throw away and recreate, while the *code* lives in a `WebAssembly.Module` that V8 has already compiled with TurboFan and that survives re-instantiation. Every analysis gets a genuinely fresh OCaml state **on top of already-optimized code**. That's the whole game.

### Instantiation: no 22 MB bundle to parse

The same structural difference shows up before the first analysis even starts. Median instantiation:

| | wasm | jsoo |
| --- | --- | --- |
| Node | 31 ms | 175 ms |
| browser | 222 ms | 463 ms |

Under Node, wasm instantiates **~5.6× faster**, because there is no 22 MB JavaScript bundle for the engine to parse and compile — just a pre-compiled module to instantiate.

## In the browser, wasm dominates

The browser makes the warm/cold divide brutal, because MOPSA runs inside a Web Worker and the worker is **respawned** between analyses. For jsoo that means a fresh realm every time, so it never warms up at all. For wasm the pre-compiled `Module` is reused across worker lifetimes, so it stays warm.

| file | wasm | jsoo | jsoo/wasm |
| --- | --- | --- | --- |
| `int_tests.u` | 27 ms | 290 ms | 10.6× |
| `loop_tests.u` | 25 ms | 325 ms | 12.9× |
| `string_tests.u` | 26 ms | 298 ms | 11.6× |
| `function_tests.u` | 31 ms | 295 ms | 9.5× |
| `list_tests.py` | 254 ms | 763 ms | 3.0× |
| `class_tests.py` | 107 ms | 359 ms | 3.4× |
| `exception_tests.py` | 119 ms | 363 ms | 3.1× |
| `generator_tests.py` | 124 ms | 362 ms | 2.9× |
| `misc_tests.py` | 116 ms | 408 ms | 3.5× |

**~3× on python, ~10× on the tiny universal files**, plus the 2× instantiation advantage. In an interactive browser tool — where you edit code and re-analyze repeatedly — this is exactly the regime that matters, and it's the one the wasm build was designed for.

## Memory

Native is the leanest; the wasm build pays for its linear memory and preloaded data. Median peak RSS under Node:

| | native | wasm | jsoo |
| --- | --- | --- | --- |
| RSS | 71 MB | 235 MB | 190 MB |

The browser RSS numbers (~35 MB for both) aren't comparable — they're an approximate JS-heap figure that doesn't count the worker where the actual work happens — so I leave them out of the comparison.

## Takeaways

- **Only the wasm build does C.** jsoo can't carry the native stack, so the whole C + Apron workload is wasm-vs-native or nothing.
- **Native is ~8–10× faster than wasm** warm on real work. That's the interpretation tax, and it's an acceptable one for a browser.
- **jsoo wins a single cold run** (~1.2–1.4×), because AOT JS beats a cold interpreter.
- **wasm wins everything repeated.** Warm it's ~1.5× faster than jsoo under Node, ~3× in the browser (and up to ~10× on tiny files), it instantiates ~5.6× faster, and it's the only one that keeps a warm JIT *and* a fresh OCaml state at the same time.

The short version: if you run one analysis once from a CLI, jsoo's cold start is hard to beat where it can run at all. If you run many analyses in a live tab — which is what an interactive analyzer actually is — compiling the runtime to wasm and re-instantiating a pre-optimized module wins, and it's the only option that runs the full C stack.

The raw benchmark data and harness are in the [mopsa-emcc repo](https://github.com/rboudrouss/mopsa-emcc), and the live build is at [mopsawasm.rboud.com](https://mopsawasm.rboud.com/).
