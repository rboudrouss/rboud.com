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


## The architectural bet: interpret the bytecode, don't recompile OCaml

First, why not `wasm_of_ocaml`, `js_of_ocaml`, or `wasocaml`? They all share the same blind spot: they compile the OCaml and leave the C/C++ behind. That's fine for a pure-OCaml project (or one whose few native dependencies already have a JS reimplementation, like `zarith_stubs_js`). But as far as I could tell, none of them offers a general escape hatch that *doesn't* require hand-writing glue to bridge wasm and JS. In my case that would mean rewriting `Clang_to_ml.cc` entirely in JavaScript, and then maintaining that rewrite.

What I wanted instead was:

- **As little code as possible**, so the result stays maintainable.
- **As few moving parts as possible.** Getting a module compiled by `wasm_of_ocaml` to talk to one compiled by `emscripten` would mean understanding, in depth, how each compiler lays out and manages memory, and then writing the plumbing to stitch the two together.

And there was a more concrete problem underneath all this: **what do I link the FFI stubs against?** The C/C++ files that use the OCaml FFI call into runtime functions (`caml_alloc`, `caml_callback`, …). If I only compile the OCaml *code*, those symbols simply don't exist, the stubs have nothing to link against.

After a lot of trial and error (much of it still visible in [this repo](https://github.com/rboudrouss/mopsa-wasm)), the answer turned out to be the **OCaml runtime itself**: it's the thing that "*provides*" an implementation of all those `caml_*` functions.

And that quietly solves every point at once. No more juggling several tools, I can lean on `emscripten` alone, because once I bring in the runtime I'm left with nothing but C and C++ to compile.

So the plan: compile the OCaml to bytecode, compile the OCaml runtime and all the native dependencies to wasm, link that native bundle together, then run the bytecode on top. And that should just work... right?

## How do I link everything

Before thinking about compilation (something Emscripten handles well enough), it's worth thinking about linking. The interpreter needs to find, at runtime, the C code behind each `external` declared in the bytecode. And there, **OCaml resolves its C primitives dynamically** via `dlopen` and `dlsym`.

### How it works, and why it breaks

When you write `external foo : int -> int = "caml_foo"`, the compiler never emits a direct call to `caml_foo`. It assigns it a **number** and emits a `C_CALLn <index>` instruction. The name-address binding is only resolved at program startup: OCaml `dlopen`s the native libraries and `dlsym`s each primitive by name to fill a table of function pointers. At runtime, `C_CALLn <index>` is just `caml_prim_table[index](args)`.

Emscripten does have a way to emulate dynamic module loading, but it's complex to set up and splits the binary into multiple wasm modules. Since keeping everything in a single static `.wasm` seemed simpler (and at 12 MB the result is still reasonable) I chose to short-circuit this mechanism entirely.

The OCaml runtime already has a static path for this. Before searching through `.so` files, `lookup_primitive` first checks a **static table** compiled into the runtime itself:

```c
static c_primitive lookup_primitive(char * name)
{
  /* 1. built-in table, statically linked */
  for (int i = 0; caml_names_of_builtin_cprim[i] != NULL; i++)
    if (strcmp(name, caml_names_of_builtin_cprim[i]) == 0)
      return caml_builtin_cprim[i];
  /* 2. only then, dynamically loaded .so files */
  for (int i = 0; i < shared_libs.size; i++) {
    void * res = caml_dlsym(shared_libs.contents[i], name);
    if (res != NULL) return (c_primitive) res;
  }
  return NULL;
}
```

These two arrays, `caml_builtin_cprim[]` (the pointers) and `caml_names_of_builtin_cprim[]` (the names), are exactly what `ocamlc -custom` produces, a generated file, conventionally called `prims.c`, that declares all the primitives of the executable and stores them in these two tables. This is OCaml's "fully static" mode, originally designed to produce executables with no dependency on `dll*.so` files.

So then I supply my own `prims.c` containing *all* the primitives the MOPSA bytecode needs, and I disable the `dlopen` branch in the runtime (which has nothing to load anyway). The patch is a few commented-out lines in `caml_build_primitive_table`:

```c
caml_ext_table_init(&shared_libs, 8);
// wasm: shared libraries are not supported, skip open_shared_lib
// if (libs != NULL)
//   for (p = libs; *p != 0; p += strlen_os(p) + 1)
//     open_shared_lib(p);
```

`shared_libs` (the runtime's internal list of `dlopen`ed `.so` files) stays empty permanently. The second loop in `lookup_primitive` never finds anything: **every primitive must be present in my built-in table**, or the runtime halts immediately with `unknown C primitive`.

### Building `prims.o`: extracting the primitives

The table must be a **superset** of everything the bytecode calls. I collect the primitives by scanning the C/C++ sources (both the runtime's and every library I link) with a small script, `extract-primitives.js`. It follows the same idea as OCaml's `gen_primitives.sh` (`sed -n 's/^CAMLprim value \(…\)/\1/p'`) but is more robust, because MOPSA's and Apron's sources don't always follow the `CAMLprim value foo(...)` convention.

The result, ~1435 primitives, is the union of several worlds: the runtime core (`caml_*`), `unix` (131 primitives), `str`, `bigarray`/`int64`, and the 655 Apron stubs generated by CamlIDL (`camlidl_*_ap_*`). I commit `primitives.txt` as-is; occasionally I cross-check it against `strings build/mopsa.bc` to verify it actually covers what the bytecode calls.

From that list, `prims.c` is generated with three `sed` passes in the Makefile:

```make
$(BUILD_DIR)/prims.o:
	(echo '#define CAML_INTERNALS'; \
	 echo '#include <caml/mlvalues.h>'; \
	 echo '#include <caml/prims.h>'; \
	 sed -e 's/.*/extern value &();/'        backend/wasm/primitives.txt; \
	 echo 'c_primitive caml_builtin_cprim[] = {'; \
	 sed -e 's/.*/\t&,/'                      backend/wasm/primitives.txt; \
	 echo '\t 0 };'; \
	 echo 'char * caml_names_of_builtin_cprim[] = {'; \
	 sed -e 's/.*/\t"&",/'                    backend/wasm/primitives.txt; \
	 echo '\t 0 };') > $(BUILD_DIR)/prims.c
	$(EMCC) $(EMCC_FLAGS) -Wno-incompatible-function-pointer-types \
	    -c -I $(OCAML_STDLIB) -o $(BUILD_DIR)/prims.o $(BUILD_DIR)/prims.c
```

The generated file looks like this:

```c
extern value caml_array_get();
extern value unix_read();
/* … 1435 lines … */

c_primitive caml_builtin_cprim[] = {
    caml_array_get, unix_read, /* … */ 0 };

char * caml_names_of_builtin_cprim[] = {
    "caml_array_get", "unix_read", /* … */ 0 };
```

Each primitive is declared `extern value foo();` with no argument prototype. Their actual signatures differ (arities 1 to 5, plus `N`), but that doesn't matter, the interpreter always recasts the pointer to the right arity at the call site (`Primitive1(n)`, `Primitive2(n)`, … in `prims.h`). Hence the `-Wno-incompatible-function-pointer-types` that silences the expected warning.

## Compiling the ocaml runtime (4.14.2)

Compiling the runtime is fairly straightforward, with one small catch. OCaml 4.14 introduced `runtime/sak`, a tool run on the host to encode the stdlib path as a C string literal. `emconfigure` compiles it with `emcc` and produces a `.wasm` binary that cannot be executed natively and the build continues silently, the path stays empty, and the failure only surfaces at runtime. The fix is to compile `sak` manually with the real `cc` before calling `make`.

```make
CFLAGS="$(CFLAGS)" $(EMCONFIGURE) ./configure \
    --disable-native-compiler \
    --disable-systhreads \
    --disable-ocamltest --disable-ocamldoc
rm -f runtime/sak runtime/sak.o runtime/sak.wasm
cc -c -o runtime/sak.o runtime/sak.c && cc -o runtime/sak runtime/sak.o
touch runtime/sak.o runtime/sak
CFLAGS="$(CFLAGS)" $(MAKE) -C runtime libcamlrun.a
```

The `runtime/` directory contains the `<caml/*.h>` headers that define OCaml's FFI API, the same headers every C stub compiled next depends on. Every subsequent compilation that touches the FFI passes `-I$(OCAML_STDLIB)`, pointing at that same `runtime/`. This guarantees that stubs are compiled against the exact definitions of the runtime that will execute them.

## Compiling MPFR & GMP

GMP and MPFR are the first two libraries to compile. Both build easily with Emscripten almost unchanged.

The pattern is the same for both: `emconfigure ./configure` followed by `make`. `emconfigure` rewrites the compiler environment variables (`CC`, `AR`, etc.) to point at the Emscripten toolchain, which is enough for the feature detection in `configure` to target wasm32 instead of the host.

```make
# GMP
CFLAGS="$(CFLAGS)" $(EMCONFIGURE) ./configure \
    --disable-assembly \
    --host=none \
    --prefix=$(INSTALL_DIR)
$(MAKE) && $(MAKE) install

# MPFR (depends on GMP)
touch aclocal.m4 configure
find . -name "Makefile.in" -exec touch {} \;
CFLAGS="$(CFLAGS)" $(EMCONFIGURE) ./configure \
    --with-gmp=$(INSTALL_DIR) \
    --host=none \
    --prefix=$(INSTALL_DIR)
$(MAKE) && $(MAKE) install
```

Two details worth noting.  
For GMP, `--disable-assembly` is mandatory: GMP normally uses architecture-specific assembly routines (x86, ARM...) for performance, and Emscripten cannot compile them. `--host=none` prevents `configure` from detecting and using host-specific optimizations.  
For MPFR, the `touch` on `aclocal.m4` and `configure` prevents `make` from trying to re-run autoconf to regenerate the `Makefile.in` files, which would fail inside the Emscripten environment.

The specific versions (GMP 6.1.2 and MPFR 4.2.2) are not arbitrary, they are the ones known to compile cleanly with Emscripten, identified in [a Stack Overflow answer](https://stackoverflow.com/a/43583154).


## Compiling CamlIDL based stubs

CamlIDL is a stub generator. You give it an `.idl` file describing a set of C types and functions, and it produces two things: `foo_stubs.c`, containing the C functions that convert OCaml values to and from C, and `foo.ml`/`foo.mli`, the OCaml API. The idea is to never write the conversion plumbing by hand.

Two of MOPSA's dependencies rely on this heavily: **mlgmpidl** (OCaml bindings for GMP and MPFR) and **mlapronidl** (OCaml bindings for Apron's abstract domains). Together they account for roughly 655 of the ~1435 primitives in the final table.

### CamlIDL runtime

`camlidl` runs at build time to generate the required `.ml` and `.c` files. Every generated file depends on the CamlIDL runtime which is a set of three files (`idlalloc.c`, `comintf.c`, and `comerror.c`) that provide utilities for the generated code, mainly memory allocation and interface helpers.

Here is the Makefile rule used to compile these files:

```make
$(LIBS_DIR)/libcamlidl.a:
    $(EMCC) $(EMCC_FLAGS) -D_FILE_OFFSET_BITS=64 -D_REENTRANT \
        -c -I$(OCAML_STDLIB) $(DEPS_DIR)/camlidl/runtime/idlalloc.c  -o $(BUILD_DIR)/idlalloc.o
    $(EMCC) $(EMCC_FLAGS) -D_FILE_OFFSET_BITS=64 -D_REENTRANT \
        -c -I$(OCAML_STDLIB) $(DEPS_DIR)/camlidl/runtime/comintf.c   -o $(BUILD_DIR)/comintf.o
    $(EMCC) $(EMCC_FLAGS) -D_FILE_OFFSET_BITS=64 -D_REENTRANT \
        -c -I$(OCAML_STDLIB) $(DEPS_DIR)/camlidl/runtime/comerror.c  -o $(BUILD_DIR)/comerror.o
    $(EMAR) rcs $(LIBS_DIR)/libcamlidl.a \
        $(BUILD_DIR)/idlalloc.o $(BUILD_DIR)/comintf.o $(BUILD_DIR)/comerror.o
```

Note the `-I$(OCAML_STDLIB)` flag that points at the OCaml FFI headers from the runtime we just compiled.

### mlgmpidl and mlapronidl

Both `mlgmpidl` (GMP/MPFR bindings) and `mlapronidl` (Apron abstract domain bindings) follow the same pattern: use the upstream `Makefile` to generate the CamlIDL stubs as `.c` files, then compile each one with `emcc`. For example, `mlapronidl`:

```make
$(MAKE) -C $(DEPS_DIR)/apron/mlapronidl CAMLIDL=$(CAMLIDL) PERL=$(PERL) $(MLAPRONIDL_IDL:%=%_caml.c)
for module in $(MLAPRONIDL_MODULES); do
    $(EMCC) $(EMCC_FLAGS) -c $(CAMLIDL_CFLAGS) \
        -I$(DEPS_DIR)/apron/apron -I$(DEPS_DIR)/apron/mlapronidl \
        -o $(BUILD_DIR)/$${module}.o $(DEPS_DIR)/apron/mlapronidl/$${module}.c
done
$(EMAR) rcs $@ $(addprefix $(BUILD_DIR)/,$(MLAPRONIDL_MODULES:%=%.o))
```

## Compiling APRON

Each numerical domain (box, octagons, polka) is compiled as its own archive, compiled with `-DNUM_MPQ`:

```make
$(EMCC) $(EMCC_FLAGS) -c $(CAMLIDL_CFLAGS) \
    -I$(DEPS_DIR)/apron/box -DNUM_MPQ \
    -o $(BUILD_DIR)/box_caml.o $(DEPS_DIR)/apron/box/box_caml.c
$(EMAR) rcs $(DEPS_BIN_DIR)/libboxMPQ_caml.a $(BUILD_DIR)/box_caml.o
```

`NUM_MPQ` tells Apron to use GMP's exact multi-precision rationals (`mpq_t`) instead of hardware `double` for all bounds. Apron's floating-point domains normally rely on `fesetround` to control hardware rounding direction, but WebAssembly has no FPU rounding mode control. With `NUM_MPQ`, every bound is computed exactly via GMP and `fesetround` is never needed.


## Compiling LLVM/Clang 9

A good chunk of LLVM is *generated* automatically by native tools (`llvm-tblgen` and `clang-tblgen`) that must run natively on the host machine.

### The two-stage build


**Stage 1: build the native tools.**

```make
cmake -G Ninja -S $(LLVM_WASM_SRC)/llvm -B $(LLVM_NATIVE_BUILD) \
  -DCMAKE_C_COMPILER=gcc-11 \
  -DCMAKE_CXX_COMPILER=g++-11 \
  -DLLVM_ENABLE_PROJECTS=clang \
  -DLLVM_TARGETS_TO_BUILD=host \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_BUILD_TOOLS=OFF \
  ...
ninja -C $(LLVM_NATIVE_BUILD) llvm-tblgen clang-tblgen
```

We build only `llvm-tblgen` and `clang-tblgen`, natively, with `gcc-11`. We use `gcc-11` because the LLVM 9 code is no longer compatible with recent versions of `gcc` and `clang`.

**Stage 2: build the wasm libraries**

```make
cmake -G Ninja -S $(LLVM_WASM_SRC)/llvm -B $(LLVM_WASM_BUILD) \
  -DCMAKE_TOOLCHAIN_FILE=$(EMSDK_TOOLCHAIN) \
  -DLLVM_TABLEGEN=$(LLVM_NATIVE_BUILD)/bin/llvm-tblgen \
  -DCLANG_TABLEGEN=$(LLVM_NATIVE_BUILD)/bin/clang-tblgen \
  -DLLVM_ENABLE_PROJECTS=clang \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_ENABLE_EH=OFF \
  -DLLVM_ENABLE_RTTI=OFF \
  ...
```

The `-DLLVM_TABLEGEN` and `-DCLANG_TABLEGEN` flags point directly at the native tools we already built.

### The libraries we keep

We don't build all of LLVM.

```make
ninja -C $(LLVM_WASM_BUILD) \
  clangFrontend clangParse clangAST clangLex clangBasic \
  clangSema clangDriver clangEdit clangSerialization \
  clangAnalysis clangStaticAnalyzerCore \
  LLVMSupport LLVMCore LLVMMC LLVMMCParser \
  LLVMBinaryFormat LLVMBitReader LLVMBitstreamReader \
  LLVMOption LLVMProfileData LLVMDemangle LLVMRemarks
```

No code-generation backend (`LLVMX86*`, `LLVMAArch64*`, etc.), no optimizers (`LLVMTransformUtils`, `LLVMInstCombine`, etc.). We only want the parsing frontend (lexer, parser, AST, semantics) and the minimal LLVM support it requires.

And that's it, we have our LLVM compiled.

## Compiling `Clang_to_ml.cc`

`Clang_to_ml.cc` is the heart of MOPSA's C frontend. It's a ~5000-line file that does two things at once:

1. It drives Clang to parse a C file (via `CompilerInstance`, `ParseAST`, `RecursiveASTVisitor`).
2. It allocates OCaml values and fills them with data from the Clang AST.

What makes this file special is that it includes *both* Clang headers and OCaml runtime headers at the same time:

```cpp
// Clang headers
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Frontend/CompilerInstance.h"
// ...

// OCaml headers
#include <caml/mlvalues.h>
#include <caml/alloc.h>
#include <caml/memory.h>
// ...
```

At each node of the Clang AST, the visitor creates a corresponding OCaml block with `caml_alloc`, stores fields into it with `Store_field`, and returns an OCaml `value` to the OCaml code that called into this C++. This is allocation inside the OCaml garbage collector's heap, from C++, using the `CAMLparam`/`CAMLlocal`/`CAMLreturn` macros that maintain the GC's invariants.

Compiling this file requires three sets of includes at once:

```make
em++ -std=c++14 \
  -I$(LLVM_WASM_SRC)/llvm/include \           # LLVM headers
  -I$(LLVM_WASM_SRC)/clang/include \          # Clang headers (sources)
  -I$(LLVM_WASM_BUILD)/include \              # TableGen-generated headers
  -I$(LLVM_WASM_BUILD)/tools/clang/include \  # generated Clang headers
  -I$(OCAML_STDLIB) \                         # <caml/*.h> from the OCaml runtime
  -DCLANGRESOURCE=\"/clang-headers\" \
  -fno-rtti -fno-exceptions \
  -c $(CLANG_TO_ML_SRC) -o $(BUILD_DIR)/clang_to_ml.o
```

The `-DCLANGRESOURCE="/clang-headers"` is explained right below.

### Clang's resource headers

To parse C, Clang needs its own built-in headers: `stddef.h`, `limits.h`, `__stddef_max_align_t.h`, etc. These are Clang-specific headers, distinct from the system headers, that define the fundamental types and macros in a portable way. On a normal Linux system, they live in `/usr/lib/clang/9.0.1/include/`.

In a wasm binary, there's no system filesystem. We preload them into Emscripten's virtual filesystem:

```make
ninja -C $(LLVM_WASM_BUILD) install-clang-resource-headers
# installs into $(INSTALL_DIR)/lib/clang/9.0.1/include/
```

And in the final link:
```make
--preload-file $(INSTALL_DIR)/lib/clang/9.0.1/include@/clang-headers/include
```

`Clang_to_ml.cc` is compiled with `-DCLANGRESOURCE="/clang-headers"`, which tells Clang where to look for these headers in the virtual FS. Without it, the first `#include <stddef.h>` in an analyzed C file fails with a header-not-found error in the browser.

## The final link: everything static

emscripten's final link pulls everything into a single `ocamlrun.wasm`:

```make
$(EMCC) ... -o $(DIST_DIR)/ocamlrun.js \
    --preload-file $(BUILD_DIR)/mopsa.bc@/build/mopsa.bc \
    $(LIBS_DIR)/*.a \
    -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
    $(BUILD_DIR)/prims.o $(BUILD_DIR)/libcamlrun.a
```

Three things worth noting:

- **Everything is statically linked**: `libcamlrun.a` (the interpreter), `prims.o` (the primitive table), and all the `.a` archives (GMP, MPFR, Apron, the CamlIDL runtime, the OCaml Apron stubs (box/oct/polka), Zarith, Clang/LLVM, MOPSA's C parser, and my `libmopsa_primitives.a` (unix + str)). That's what yields a self-contained `.wasm` of ~15 MB.
- `ERROR_ON_UNDEFINED_SYMBOLS=1` guarantees that **every symbol named in `caml_builtin_cprim[]` actually exists** in one of the archives. If `primitives.txt` names a primitive that nothing provides, the wasm link fails loudly rather than hitting `unknown C primitive` at runtime, in the browser, at the worst possible moment.
- **`mopsa.bc` is not linked**, it is *preloaded* into emscripten's virtual filesystem, then interpreted at runtime by `ocamlrun`. It's bytecode, not native code.

We did everything right, yet at runtime in the browser we hit an "index out of bounds".

## OCaml values at the FFI boundary on wasm32

The "index out of bounds" leads us straight into OCaml's memory representation. An OCaml value is either *immediate* (an integer encoded directly in the word, with its low bit set to 1) or a boxed *block* (a pointer to a heap region preceded by a **header word**). That header, placed right *before* the pointer, encodes three fields: the **tag** (the low 8 bits, the block's constructor, or `Double_array_tag`, `String_tag`, etc.), the **wosize** (size in words) and the GC **color**.

```
        Header                  block data
   ┌──────────────────┐   ┌──────────┬──────────┬─────
   │ wosize| col | tag│   │ field 0  │ field 1  │ ...
   └──────────────────┘   └──────────┴──────────┴─────
          val[-1]              ▲ val points here
```

Tracing the "index out of bounds" back to the macro, we land on OCaml 4.14.2's form of `Tag_val`, in little-endian:

```c
#define Tag_val(val) (((unsigned char *) (val)) [-sizeof(value)])
```

My first thought was a bad compilation of `sizeof(value)` or a 64/32-bit mismatch. But `sizeof` is a compile-time constant, and it always evaluates to `4` here; the config is perfectly consistent under ILP32 (`SIZEOF_PTR == SIZEOF_LONG == 4`, and `ARCH_SIXTYFOUR` being undefined implies `intnat == value == header_t == uintnat == 4` bytes), and no build path ever switches to 64 bits. The hypothesis of a 64-bit `header_t` or a mis-evaluated `sizeof` is wrong.

The real problem is an **unsigned negation**. The type of `sizeof(value)` is `size_t`, *unsigned* (4 bytes on wasm32). So the negation never produces `-4`, it wraps around:

```
-sizeof(value) = -(size_t)4 = 0xFFFFFFFC   (unsigned wraparound, not -4!)
p[0xFFFFFFFC]  = *(p + 0xFFFFFFFC)
```

To see why the *same* expression behaves differently on x86 and on wasm, you have to follow it through the compiler. Clang doesn't emit a memory access directly: it first lowers `p[idx]` into a [`getelementptr`](https://llvm.org/docs/LangRef.html#getelementptr-instruction) (GEP) in LLVM IR (the instruction that computes `address = base + index × sizeof(element)`) and *then* the backend lowers that GEP, together with the load, into a native (or wasm) memory instruction. The C is identical on both targets, only this last lowering step differs.

**On native 32-bit**, the effective address lives in a 32-bit register, and `p + 0xFFFFFFFC` is a plain 32-bit `add`. The add overflows and the hardware silently truncates modulo 2³², so the result is *exactly* `p - 4`. It is technically overflowing, but it "works" by wraparound, which is why upstream OCaml gets away with it on every 32-bit native platform.

**On wasm32**, addresses are also `i32`, so you might expect the same wrap. But wasm offers two ways to add an offset, and they don't behave the same:

- an explicit `i32.add`, which *does* wrap modulo 2³², this would have given `p - 4` and worked.
- the **static offset baked into the memory instruction** (`i32.load offset=N`), where the runtime computes the effective address as `ea = base + N` and bounds-checks `ea + access_size` against the linear-memory size. That comparison is done on the full, untruncated value and it does **not** wrap modulo 2³².

Because `0xFFFFFFFC` is a compile-time constant, LLVM does the natural optimization and folds it into the load's static offset rather than emitting a separate `i32.add`. So instead of computing `p - 4`, the runtime checks:

```
ea = p + 0xFFFFFFFC   ~ 4 GiB, no wraparound
ea + 1 > memory_size  -> trap -> out of bounds
```

That trap *is* the "index out of bounds" we saw. The unsigned `0xFFFFFFFC` survives as a near-4 GiB constant offset that the wasm bounds check rejects.

So we apply this fix to avoid any unsigned negation:

```c
#define Hd_val(val)      (*((uint32_t *)(val) - 1))
#define Tag_val(val)     ((tag_t)(Hd_val(val) & 0xFF))
#define Tag_set(val, t)  (Hd_val(val) = (Hd_val(val) & ~(uint32_t)0xFF) | (uint32_t)(tag_t)(t))
```

In `(uint32_t *)val - 1`, the `- 1` is a *signed* integer applied to a typed pointer, with no unsigned negation. `Tag_val` is no longer an l-value (you can't write through it anymore), so I added `Tag_set`, which rewrites *only* the tag byte while preserving the wosize and the color. The few sites that wrote the tag via `Tag_val(...) = ...` were migrated to `Tag_set`.

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
- Toute l'histoire javascript, notamment comment on a fait l'interactif, le worker, l'api etc....

## 10. Bonus: cross C/Python analysis

- The `mopsa.db` generation in `mopsa_worker.ml`, the argument split, the multilanguage
  pipeline. (Short — a teaser for a possible follow-up post.)

## 11. Wrap-up

- Perf profile (Clang parsing dominates), size (~15 MB), what this demonstrates.
- Honesty about the "first" claim → a *Prior art* sidebar (see note below).
- Outlook: upstream the OCaml patches?

---

## Remerciements

Le port OCaml → WASM repose sur le travail de [Vincent Chan](https://github.com/okcdz) sur [`ocaml-wasm`](https://github.com/vincentdchan/ocaml) (août 2021), qui a fourni les tweaks `configure` originaux et les stubs Unix (`unix_lib.c`, `socketaddr.c`, `unixsupport.c`, …) nécessaires pour faire tourner le runtime OCaml sous emscripten.

Pour la compilation LLVM/Clang vers wasm, [le fork de Binji](https://github.com/binji/llvm-project) et [ses notes](https://gist.github.com/binji/b7541f9740c21d7c6dac95cbc9ea6fca) ont été essentiels pour comprendre comment s'y prendre.

Les versions spécifiques de GMP et MPFR compatibles avec emscripten ont été trouvées grâce à [cette réponse Stack Overflow](https://stackoverflow.com/a/43583154).

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
