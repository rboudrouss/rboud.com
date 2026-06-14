---
title: "How I compiled MOPSA to WebAssembly"
description: "A static analyzer written in OCaml with native C/C++ dependencies, and what it took to drag the FFI boundary onto wasm32."
pubDate: 2026-06-04
---

- https://mopsawasm.rboud.com/

MOPSA is a static analyzer based on abstract interpretation. It analyzes C and Python code, and it's written *mostly* in OCaml. That "mostly" is doing a lot of work, under the OCaml sits a stack of native libraries (GMP, MPFR, Zarith, Apron for the numerical domains, and LLVM/Clang to parse C) all bound to OCaml through its foreign function interface (FFI).

And I wanted to run it *100% client side in the browser*, no server. The analyzer itself compiled to WebAssembly.

This post is how I got there. OCaml has had workable wasm solutions for a while, like `wasm_of_ocaml`. The hard part is everything *around* the OCaml. The FFI goes both ways (OCaml calls into C/C++, and C/C++ build and read OCaml values directly). Getting that mix (`.ml` + `.c` + `.cc` + generated camlidl FFI stubs) to agree on what an OCaml value *is* on `wasm32` is where the real work lives.


## Why the hard part isn't OCaml at all

![Mopsa deps](./mopsa_deps.svg)

The diagram above shows every dependency that ships C or C++ code. The dashed ones use OCaml's FFI in one way or another. It's a bit of a mess, here are the spots worth paying particular attention to:

- `floats_round.c` is a MOPSA-internal file that implements floating-point arithmetic with control over the rounding mode, which is useful for interval analysis. To do that, it relies on `fesetround` (declared in `<fenv.h>`) to set the floating-point rounding mode. Except there's no equivalent in wasm, where everything is round-to-nearest, ties-to-even.
- `Clang_to_ml.cc` is a 5k-line MOPSA-internal file that bridges Clang and MOPSA. Its job is to take a C/C++ file, parse it with Clang, walk the AST Clang produces, and turn each node of that AST into an OCaml `value` the analyzer can then manipulate.
- `camlidl` is a stub generator between OCaml and C, used notably by Apron and mlgmpidl. Any code it generates uses the OCaml FFI, and on top of that depends on the *camlidl runtime*, a set of "utility" functions.

So a lot of the C/C++ here doesn't just compute and return, it allocates inside OCaml's heap and reads the tags and fields of OCaml blocks. Every one of those call sites bakes in an assumption about what an OCaml value is, byte for byte, in memory.


## 3. The architectural bet: interpret the bytecode, don't recompile OCaml

- **Why not `js_of_ocaml` / `wasm_of_ocaml` / `wasocaml`?** They all share one blind spot:
  they compile the *OCaml* (bytecode or typedtree) and leave the C/C++ behind. Fine for a
  pure-OCaml project — but MOPSA's analysis *is* GMP + Apron + Clang reached through the
  FFI. Going that route means reimplementing every native primitive in JS/wasm by hand.
- **The bet, the other direction:** don't recompile the OCaml. Compile `ocamlrun`
  (the bytecode interpreter) to wasm via emscripten; statically link all the native code
  (C/C++ libs + FFI stubs) into **one `ocamlrun.wasm`**; preload `mopsa.bc` into the
  virtual filesystem. emscripten is what lets the native C/C++ come along for the ride.
- Architecture diagram. Lineage: Vincent Chan's fork, Binji's LLVM notes.

## 4. ⭐ The core fight: OCaml values across the FFI boundary on wasm32

*The signature section — the longest, the payoff. Target ~30–40% of the article.*

- Primer: how an OCaml value is represented (immediate vs boxed block, the **header word**
  before the pointer, tag + wosize + color). Memory diagram.
- Why this touches **all** of the FFI: every camlidl stub, every `caml_alloc`,
  `Clang_to_ml.cc` — they all read the tag via `Hd_val`/`Tag_val` = pointer arithmetic on
  the header.
- The bug: under emscripten, `header_t` width and the byte-by-byte access in `Tag_val`
  were miscompiled → corrupted tag the moment a C/C++ stub touched an OCaml value.
  Symptoms (silent crashes / nonsense values).
- The diagnosis (how you trace it back to the macro).
- **The fix, with the diff:** `Hd_val` → `*((uint32_t*)val - 1)`, `Tag_val` made
  non-l-value, new `Tag_set` (mask 0xFF, preserving wosize/color); propagation into
  `compare.c` / `hash.c` / `obj.c` / `alloc.c`.
- Why *this* is what unblocks the entire native FFI chain.

## 5. 31-bit ints → why the bytecode itself must be built 32-bit

- OCaml bytecode bakes in the native `int` width; wasm32 = 31-bit OCaml ints.
- Hence the `linux/386` Docker build: OCaml 4.14.2 built from source
  `--host=i686-linux-gnu` (the `uname` / `REG_RIP` / `SIGSTKSZ` trick), opam i686,
  a system switch.
- **The honest plot twist** (from my notes): in practice the *native 64-bit* bytecode
  also runs on wasm32 — why, and what that says about bytecode portability.
  Sidebar: "what I expected vs what actually happened".

## 6. Generating the FFI glue: camlidl + Apron, cross-compiled

- camlidl regenerates the bindings' C stubs at build time; each `.c` recompiled with `emcc`.
- The Makefile orchestration (mlapronidl, then box/oct/polka in `-DNUM_MPQ`).
- Tie back to §4: these stubs are exactly the code that would have crashed without the
  `Tag_val` patch.

## 7. Compiling LLVM/Clang 9 to wasm (the C++ half)

- Two-stage cross-compile: native `llvm-tblgen` / `clang-tblgen` first, then the wasm libs.
- The ~30 min, RTTI/EH off, the list of Clang libs.
- `Clang_to_ml.cc`: the C++→OCaml bridge, and the Clang resource headers preloaded into
  the virtual FS.

## 8. The long tail of soundness under wasm

- Apron FPU missing → `__wrap_ap_fpu_init` returns `true` (safe under NUM_MPQ, exact GMP).
- `floats_round` re-inflated by 1 ULP (`nextafter` / `nextafterf`) for wasm's
  round-to-nearest.
- `FLT_EVAL_METHOD` / SSE2 during the i386 build.
- C++ reference types modeled as pointers → the CPython stubs parse on 32-bit.

## 9. From a .wasm to a real app

- emscripten virtual FS (preloading `mopsa.bc`, Clang/linux32 headers, `share/mopsa`),
  the primitive table (`prims.o`) + the unix/str primitives.
- `MODULARIZE` = a fresh instance per analysis (the OCaml runtime is not re-entrant;
  no Asyncify because of OCaml exceptions' setjmp/longjmp).
- Web Worker; synchronous stdin via `SharedArrayBuffer` / `Atomics.wait` for the
  interactive/DAP sessions; COOP/COEP.

## 10. Bonus: cross C/Python analysis

- The `mopsa.db` generation in `mopsa_worker.ml`, the argument split, the multilanguage
  pipeline. (Short — a teaser for a possible follow-up post.)

## 11. Wrap-up

- Perf profile (Clang parsing dominates), size (~15 MB), what this demonstrates.
- Honesty about the "first" claim → a *Prior art* sidebar (see note below).
- Outlook: upstream the OCaml patches?

---

## Source map (where the war stories live, for drafting)

- `Hd_val` / `Tag_val` / `Tag_set` patch → `deps/ocaml-wasm`, commit `1ace8399bb`
  (`runtime/caml/mlvalues.h`, `compare.c`, `hash.c`, `obj.c`, `alloc.c`)
- 32-bit bytecode build → `docker/Dockerfile.mopsa-32bc`, `docker/build-mopsa-32bc.sh`,
  Makefile `mopsa-bc-32` / `extract-32-headers`
- camlidl / Apron FFI cross-compile → Makefile `apron_caml`, `gmp_caml`, `zarith`
- LLVM/Clang wasm build → Makefile `llvm-tblgen`, `clang-wasm`, `clang_to_ml`;
  `deps/mopsa-analyzer/parsers/c/lib/parser/Clang_to_ml.cc`
- Soundness fixes → `backend/wasm/ap_fpu_wasm.c`; mopsa fork commits `6941f4f3d`
  (floats_round), `4e0af0f87` (C++ refs as pointers), `10e5561bc` (cpython ob_type)
- Runtime/app glue → `backend/wasm/mopsa_api.js`, `mopsa_worker.js`, `mopsa_worker.ml`,
  `prims.o` (Makefile `prims`), Makefile `final-web`
