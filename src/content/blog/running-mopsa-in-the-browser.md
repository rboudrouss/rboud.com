---
title: "How I compiled MOPSA to WebAssembly"
description: "A static analyzer written in OCaml with native C/C++ dependencies, and what it took to drag the FFI boundary onto wasm32."
pubDate: 2026-06-04
---

- https://mopsawasm.rboud.com/

MOPSA is a static analyzer based on abstract interpretation. It analyzes C and Python code, and it's written *mostly* in OCaml. Under the OCaml sits a stack of native libraries (GMP, MPFR, Zarith, Apron for the numerical domains, and LLVM/Clang to parse C) all bound to OCaml through its foreign function interface (FFI).

And I wanted to run it *100% client side in the browser*, no server. The analyzer itself compiled to WebAssembly.

OCaml has had workable wasm solutions for a while, like `wasm_of_ocaml`. The hard part is everything *around* the OCaml. The FFI goes both ways (OCaml calls into C/C++, and C/C++ build and read OCaml values directly). Getting that mix (`.ml` + `.c` + `.cc` + generated camlidl FFI stubs) to agree on what an OCaml value *is* on `wasm32` is where the real work lives.


## The Dependencies

![Mopsa deps](./mopsa_deps.svg)

The diagram above shows every dependency that ships C or C++ code. The dashed ones use OCaml's FFI in one way or another. It's a bit of a mess, here are the spots worth paying particular attention to:

- `floats_round.c` is a MOPSA-internal file that implements floating-point arithmetic with control over the rounding mode, which is useful for interval analysis. To do that, it relies on `fesetround` (declared in `<fenv.h>`) to set the floating-point rounding mode. Except there's no equivalent in wasm, where everything is round-to-nearest, ties-to-even.
- `Clang_to_ml.cc` is a 5k-line MOPSA-internal file that bridges Clang and MOPSA. Its job is to take a C/C++ file, parse it with Clang, walk the AST Clang produces, and turn each node of that AST into an OCaml `value` the analyzer can then manipulate.
- `camlidl` is a stub generator between OCaml and C, used notably by Apron and mlgmpidl. Any code it generates uses the OCaml FFI, and on top of that depends on the *camlidl runtime*, a set of "utility" functions.

So a lot of the C/C++ here doesn't just compute and return, it allocates inside OCaml's heap and reads the tags and fields of OCaml blocks. Every one of those call sites bakes in an assumption about what an OCaml value is, byte for byte, in memory.

## The architectural bet

First, why not `wasm_of_ocaml`, `js_of_ocaml`, or `wasocaml`? They all share the same blind spot: they compile the OCaml and leave the C/C++ behind. That's fine for a pure-OCaml project (or one whose few native dependencies already have a JS reimplementation, like `zarith_stubs_js`). But as far as I could tell, none of them offers a general escape hatch that *doesn't* require hand-writing glue to bridge wasm and JS. In my case that would mean rewriting `Clang_to_ml.cc` entirely in JavaScript, and then maintaining that rewrite.

What I wanted instead was:

- **As little code as possible**, so the result stays maintainable.
- **As few moving parts as possible.** Getting a module compiled by `wasm_of_ocaml` to talk to one compiled by `emscripten` would mean understanding, in depth, how each compiler lays out and manages memory, and then writing the plumbing to stitch the two together.

And there was a more concrete problem: **what do I link the FFI stubs against?** The C/C++ files that use the OCaml FFI call into runtime functions (`caml_alloc`, `caml_callback`, …). If I only compile the OCaml *code*, those symbols simply don't exist, the stubs have nothing to link against.

After a lot of trial and error (much of it still visible in [this repo](https://github.com/rboudrouss/mopsa-wasm)), the answer turned out to be the **OCaml runtime itself**, it "*provides* an implementation" of all those `caml_*` functions.

And that quietly solves every point at once. I can lean on `emscripten` alone, because once I bring in the runtime I'm left with nothing but C and C++ to compile.

So the plan: compile the OCaml to bytecode, compile the OCaml runtime and all the native dependencies to wasm, link that native bundle together, then run the bytecode on top. And that should just work... right?

## How do I link everything

Before thinking about compilation (something Emscripten handles well enough), it's worth thinking about linking. The interpreter needs to find, at runtime, the C code behind each `external` declared in the bytecode. And there, **OCaml resolves its C primitives dynamically** via `dlopen` and `dlsym`.

### How Ocaml bytecode looks for primitives

When you write `external foo : int -> int = "caml_foo"`, the compiler never emits a direct call to `caml_foo`. It assigns it a number and emits a `C_CALLn <index>` instruction. The name-address binding is only resolved at program startup where OCaml `dlopen`s the native libraries and `dlsym`s each primitive by name to fill a table of function pointers. At runtime, `C_CALLn <index>` is just `caml_prim_table[index](args)`.

Emscripten does have a way to emulate dynamic module loading (`SIDE_MODULE` & `MAIN_MODULE`), but it's complex to set up without editing too much Ocaml's code and splits the binary into multiple wasm modules. Since keeping everything in a single static `.wasm` seemed simpler (and at 12 MB the result is still reasonable) I chose to short-circuit this mechanism entirely.

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

These two arrays, `caml_builtin_cprim[]` (the pointers) and `caml_names_of_builtin_cprim[]` (the names), are exactly what `ocamlc -custom` produces (Ocaml's "fully static" mode): a generated file, conventionally called `prims.c`, that declares all the primitives of the executable and stores them in these two tables.

So then I supply my own `prims.c` containing *all* the primitives the MOPSA bytecode needs, and I disable the `dlopen` branch in the runtime (which has nothing to load anyway).

`shared_libs` (the runtime's internal list of `dlopen`ed `.so` files) stays empty permanently. The second loop in `lookup_primitive` never finds anything: **every primitive must be present in my built-in table**, or the runtime halts immediately with `unknown C primitive`.

### Building `prims.c`

The table must be a **superset** of everything the bytecode calls. I collect the primitives by scanning the C/C++ sources (both the runtime's and every library I link) with a small script, `extract-primitives.js`. It follows the same idea as OCaml's `gen_primitives.sh` (`sed -n 's/^CAMLprim value \(…\)/\1/p'`) but is more robust, because MOPSA's and Apron's sources don't always follow the `CAMLprim value foo(...)` convention.

~1435 primitives that contains: the runtime core (`caml_*`), `unix` (131 primitives), `str`, `bigarray`/`int64`, and the 655 Apron stubs generated by CamlIDL (`camlidl_*_ap_*`).

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

Each primitive is declared `extern value foo();` with no argument prototype. Their actual signatures differ (arities 1 to 5, plus `N`), but that doesn't matter, the interpreter always recasts the pointer to the right arity at the call site (`Primitive1(n)`, `Primitive2(n)`, ... in `prims.h`). Hence the `-Wno-incompatible-function-pointer-types` that silences the expected warning.

## Compiling the ocaml runtime (libcamlrun.a)

I chose to use the latest OCaml 4 bytecode interpreter (`4.14.2` when I started), as OCaml 5 introduces major runtime features such as domains and effects, which I expected would make compilation to and execution on WebAssembly more challenging. I did not investigate this further, although it may well be possible.

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

## Compiling MPFR & GMP (libgmp.a & libmpfr.a)

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

Two details worth noting :
- For GMP, `--disable-assembly` is mandatory: GMP normally uses architecture-specific assembly routines (x86, ARM...) for performance, and Emscripten cannot compile them. `--host=none` prevents `configure` from detecting and using host-specific optimizations.  
- For MPFR, the `touch` on `aclocal.m4` and `configure` prevents `make` from trying to re-run autoconf to regenerate the `Makefile.in` files, which would fail inside the Emscripten environment.

The specific versions (GMP 6.1.2 and MPFR 4.2.2) are not arbitrary, they are the ones known to compile cleanly with Emscripten, identified in [a Stack Overflow answer](https://stackoverflow.com/a/43583154).


## Compiling CamlIDL based stubs

CamlIDL is a stub generator. You give it an `.idl` file describing a set of C types and functions, and it produces two things: `foo_stubs.c`, containing the C functions that convert OCaml values to and from C, and `foo.ml`/`foo.mli`, the OCaml API. The idea is to never write the conversion plumbing by hand.

Two of MOPSA's dependencies rely on this heavily: **mlgmpidl** (OCaml bindings for GMP and MPFR) and **mlapronidl** (OCaml bindings for Apron's abstract domains). Together they account for roughly 655 of the ~1435 primitives in the final table.

### CamlIDL runtime (libcamlid.a)

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

While this reduces some floating-point imprecision, a source of unsoundness persists when APRON gets floats in its API before converting them to GMP rationals.

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
- `ERROR_ON_UNDEFINED_SYMBOLS=1` guarantees that every symbol named in `caml_builtin_cprim[]` actually exists in one of the archives. If `primitives.txt` names a primitive that nothing provides, the wasm link fails loudly rather than hitting `unknown C primitive` at runtime, in the browser, at the worst possible moment.
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

My first thought was a bad compilation of `sizeof(value)` or a 64/32-bit mismatch. But `sizeof` is a compile-time constant, and it always evaluates to `4` here. The config is perfectly consistent under ILP32 (`SIZEOF_PTR == SIZEOF_LONG == 4`, and `ARCH_SIXTYFOUR` being undefined implies `intnat == value == header_t == uintnat == 4` bytes), and no build path ever switches to 64 bits.

The real problem was subtler. The type of `sizeof(value)` is `size_t`, *unsigned* (4 bytes on wasm32), so negating it never produces `-4`, it wraps around into a large positive constant:

```
-sizeof(value) = -(size_t)4 = 0xFFFFFFFC   (unsigned wraparound, not -4!)
p[0xFFFFFFFC]  = *(p + 0xFFFFFFFC)
```

The negation itself isn't the problem, the sign of the constant it leaves behind is. A genuinely signed `-4`, such as `((unsigned char *) val)[-4]` or the `- 1` on a typed pointer that the fix ends up using, compiles cleanly. Only the unsigned `size_t` form breaks, because it carries the positive constant `0xFFFFFFFC`. Why that sign alone decides correctness comes down to how the compiler lowers the expression.

Clang doesn't emit a memory access directly. It first lowers `p[idx]` into a [`getelementptr`](https://llvm.org/docs/LangRef.html#getelementptr-instruction) (GEP) in LLVM IR, the instruction that computes `address = base + index × sizeof(element)`, and *then* the backend lowers that GEP, together with the load, into a native (or wasm) memory instruction. The C is identical on both targets, only this last step differs:

**On native 32-bit**, the effective address lives in a 32-bit register, and `p + 0xFFFFFFFC` is a plain 32-bit `add`. The add overflows and the hardware silently truncates modulo 2³², so the result is *exactly* `p - 4`. It is technically overflowing, but it "works" by wraparound, which is why upstream OCaml gets away with it on every 32-bit native platform, whatever the sign of the constant.

**On wasm32**, addresses are also `i32`, so you might expect the same wrap, but wasm has two ways to add an offset and they don't agree. An explicit `i32.add` *does* wrap modulo 2³², and would have given `p - 4`. The other way is the static offset baked into the memory instruction itself, `i32.load offset=N`, where `N` is an *unsigned* `u32` immediate. The runtime forms `ea = base + N` and bounds-checks `ea + access_size` against the linear-memory size on the full, untruncated value, with no wraparound. Because that immediate is unsigned, the backend can only fold a *non-negative* constant into it, and a negative displacement has to stay an explicit, wrapping `i32.add`. A signed `-4` cannot go in the offset, so it survives as an `i32.add` and wraps to `p - 4`. Our unsigned `0xFFFFFFFC` is a perfectly valid non-negative offset, so LLVM folds it into the load, and the runtime instead checks:

```
ea = p + 0xFFFFFFFC   ~ 4 GiB, no wraparound
ea + 1 > memory_size  -> trap -> out of bounds
```

That trap *is* the "index out of bounds" we saw. The unsigned `0xFFFFFFFC` survives as a near-4 GiB constant offset that the bounds check rejects. Compiling the two foms side by side (the unsigned `[-sizeof(value)]` and a signed `[-4]`) with the project's own compiler (`emcc 4.0.22`, `clang 22`) at `-O2` produce these two wasm. Note that the difference is only signedness:

```wat
;; ((unsigned char *) v)[-sizeof(value)]   -- original, size_t offset
(func $tag_old (param i32) (result i32)
  local.get 0
  i32.load8_u offset=4294967292)            ;; 0xFFFFFFFC folded into the load -> traps

;; ((unsigned char *) v)[-4]                -- signed literal
(func $tag_signed4 (param i32) (result i32)
  local.get 0
  i32.const -4
  i32.add                                   ;; explicit wrapping add -> p - 4, fine
  i32.load8_u)
```

The folding is itself a property of this particular backend rather than of wasm as such. `wasi-sdk clang 18` on the same machine declines to fold even the unsigned form, emits the wrapping `i32.add`, and the original macro happens to work there. So rather than rely on any backend folding the offset correctly, the fix simply never produces the unsigned constant in the first place:

```c
#define Tag_val(val)     ((tag_t)(Hd_val(val) & 0xFF))
#define Tag_set(val, t)  (Hd_val(val) = (Hd_val(val) & ~(uint32_t)0xFF) | (uint32_t)(tag_t)(t))
```

Here the `- 1` in `(uint32_t *)val - 1` is a signed integer applied to a typed pointer, so the offset stays `-4`, the backend keeps the wrapping `i32.add`, and there is no positive constant left to fold. `Tag_val` is no longer an l-value, so you can't write through it anymore, and writes go through `Tag_set` instead, which rewrites *only* the tag byte and preserves the wosize and color. The few sites that used `Tag_val(...) = ...` were migrated over.

## From a `.wasm` to a real app

At this point I have a 15 MB `ocamlrun.wasm` that can interpret `mopsa.bc`. But a `.wasm` isn't an application: you have to instantiate it, hand it files to analyze, capture its output, and, for the interactive and debugger modes, *talk to it while it runs*.

### A fresh instance per analysis

I start from a **fresh instance for every analysis**, because the OCaml runtime isn't re-entrant. It leans on a whole pile of global state (the GC heap, the primitive table, the bytecode's global variables), and `mopsa.bc` ends with an `exit`. Once `main` has returned, the instance is in a state there's no clean way back from, so I can't reuse one instance across edits.

Keeping a single instance with **Asyncify** (to suspend/resume the runtime around I/O) is the obvious alternative, but Asyncify is incompatible with OCaml's exception mechanism because exceptions are built on `setjmp`/`longjmp`, and the two fight over control of the stack.

On the Emscripten side, a fresh instance per analysis comes down to `MODULARIZE=1` plus an `EXPORT_NAME`:

```make
-s MODULARIZE=1 \
-s EXPORT_NAME='createMopsaModule' \
```

Instead of instantiating the module at load time, Emscripten exposes a *factory*, `createMopsaModule(config)`, that returns a `Promise` for a fresh instance, configurable per call. Each analysis calls `createMopsaModule(...)`, lets `main` run, captures the output, then throws the instance away.

### The virtual filesystem

MOPSA is a command-line tool that reads files, a config, stubs... In the browser there's no filesystem, so we lean on **Emscripten's virtual FS**. Two halves:

- **The static part, preloaded.** Everything that never changes from one analysis to the next is packed into `ocamlrun.data` (~21 MB) at link time, via `--preload-file`:

  ```make
  --preload-file $(BUILD_DIR)/mopsa.bc@/build/mopsa.bc \
  --preload-file $(INSTALL_DIR)/lib/clang/9.0.1/include@/clang-headers/include \
  --preload-file $(LINUX32_INCLUDE_DIR)@/usr/include \
  --preload-file $(DEPS_DIR)/mopsa-analyzer/share/mopsa@/share/mopsa \
  ```

  The `mopsa.bc` bytecode, Clang's built-in headers, the linux32 system headers MOPSA needs to analyze C, and `share/mopsa` (the configs and the C/Python stubs) all land at fixed paths in the virtual FS.

- **The dynamic part, written on the fly.** The user's code, their config, and any extra files are written right before launch, in a `preRun` hook. For that I export `FS` (to write the files) and `ENV` (to set environment variables):

  ```make
  -s EXPORTED_RUNTIME_METHODS="['FS','ENV']" \
  ```

  ```js
  function makePreRun(code, config, codeFile, extraFiles) {
    return function (M) {
      if (M.ENV) M.ENV.TERM = "xterm-256color";
      M.FS.writeFile("/config.json", config);
      // ... mkdirTree + writeFile for each extra file ...
      // The code file is written LAST so it overrides any stale entry.
      M.FS.writeFile(codeFile, code);
    };
  }
  ```

  The `TERM = "xterm-256color"` lets MOPSA emit ANSI colors in its output, which we then render with `xterm.js`.

### The runner: `mopsa_worker.ml`

The bytecode's entry point is a worker `mopsa_worker.ml`, compiled to bytecode (`modes byte`, `-linkall`, `-no-check-prims`). Its job is to prepare `Sys.argv` and the environement *before* delegating to `Mopsa_analyzer.Framework.Runner`

This matters mostly for **multi-language C + Python analysis**, where MOPSA (especially when there are several C files) expects a *build DB* (`mopsa.db`) to have been generated beforehand. I build that DB by hand from all the C files.

```ocaml
(* Multi-language: generate mopsa.db from the C files, pass only the entry .py. *)
let db_path = Filename.concat workdir "mopsa.db" in
generate_db db_path c_files;
let new_argv = Array.of_list (prog :: other_args @ [entry_py]) in
```

So `mopsa_worker.ml` splits `argv` into three (flags, `.c/.h` files, `.py` files), and if there's *both* C and Python, it generates a `mopsa.db` in memory with `Mopsa_build_db`, drops it into the working directory, and passes only the Python entry point to the analyzer. This is what makes cross-C/Python analysis possible client-side (more on that below).

On the JS side, the `buildArgs` function fills out the command line with the virtual-FS paths:

```js
function buildArgs(options, isHelp) {
  return ["build/mopsa.bc"]
    .concat(isHelp ? [] : ["-config", "/config.json"])
    .concat(["-share-dir", "/share/mopsa", "-I", "/clang-headers", "-I", "/usr/include"])
    .concat(options || []);
}
```

### The API: `window.mopsaJs`

Everything goes through a global object, `window.mopsaJs`, installed by `mopsa_api.js` which is a synchronous script loaded before the React bundle, so the API is ready the instant React starts.

All the code state is kept in the main JS thread, I only reach for the wasm when it's time to analyze.

All the "filesystem" helpers (`writeFile`, `readFile`, `listDir`, `deleteFile`, ...) are backed by plain JS objects. Editing code, switching files, browsing the tree... all of it is synchronous and instant, never touching the WASM. The `.wasm` only comes into play when you call `analyze()`.

On top of that, **the Worker owns the binary**. The `.wasm` (15 MB) and the `.data` (21 MB) are heavy, we don't want to load them on the main thread, nor block the UI during an analysis that can take a while. `analyze()` just sends the current state to the Worker and returns a `Promise` resolved when the reply comes back:

```js
analyze: function (options) {
  // ... (a fresher analyze() supersedes any in-flight run) ...
  return new Promise(function (resolve) {
    var id = _nextId++;
    _pending[id] = resolve;
    _worker.postMessage({
      type: "analyze", id: id, options: options || [],
      code: _code, config: _config, codeFile: _codeFile, extraFiles: _extraFiles,
    });
  });
},
```

### The Worker and the cost of an instance

`mopsa_worker.js` fetches the `.wasm` and the `.data` **only once**, at startup. The `.wasm` is compiled up front into a `WebAssembly.Module` (via `compileStreaming`), and the `.data` is kept as an `ArrayBuffer`:

```js
var _wasmModulePromise = WebAssembly.compileStreaming(fetch("./ocamlrun.wasm"));
var _dataBufferPromise = fetch("./ocamlrun.data").then(r => r.arrayBuffer());
```

For each analysis, we re-*instantiate* this already-compiled module (fast, no network) rather than reload everything. Two Emscripten hooks let us reuse these preloaded resources:

```js
moduleConfig.instantiateWasm = function (imports, successCallback) {
  WebAssembly.instantiate(wasmModule, imports)
    .then((instance) => successCallback(instance, wasmModule));
  return {};
};
moduleConfig.getPreloadedPackage = function () { return dataBuffer; };
```

We pay for the compilation and the fetch once, and each run only pays for instantiation which is what makes "a fresh instance per analysis" affordable. The output is captured through the `print`/`printErr` callbacks. OCaml's `exit` surfaces as an `ExitStatus` exception, which we recognize by its `status` field and treat as a normal termination.

### The interactive and DAP modes

"Batch" mode is a simple round-trip, but MOPSA also has an **interactive** mode (a REPL where you step through the analysis) and a **DAP** mode (Debug Adapter Protocol). Both are a single, long-lived run that reads its stdin and *blocks* waiting for a reply.

The Worker runs the WASM synchronously, so when MOPSA reads stdin the Worker's thread is *frozen* inside the read and can't handle a `postMessage` that arrives in the meantime. This forces a **synchronous stdin**: a channel the Worker can pull a byte from in a blocking way, while the main thread writes to it asynchronously.

#### `SharedArrayBuffer` + `Atomics.wait`

The only web primitive that makes this possible is the `SharedArrayBuffer` / `Atomics.wait` pair. The Worker blocks on `Atomics.wait` until the main thread writes a message into shared memory and wakes it up. For this I use the small [`sync-message`](https://github.com/alexmojaki/sync-message) library (vendored), which wraps this protocol behind `makeChannel` / `writeMessage` / `readMessage`.

`SharedArrayBuffer` is only available if the page is **cross-origin isolated**, which requires two HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

#### Wiring a blocking stdin into Emscripten

Emscripten reads stdin through a *char device* whose read function is called **one byte at a time**, in a loop, until it returns `null` (which makes the current `read()` return). So we have to hand back one byte at a time, *and* return `null` at the end of each line to unblock `read()`. A `delivering` flag tells apart "I just finished a chunk" (return `null`, don't block) from "the start of a fresh read" (block for the next message):

```js
return function () {
  if (pos < buf.length) { delivering = true; return buf[pos++]; }
  if (eof) return null;                 // permanent EOF
  if (delivering) { delivering = false; return null; }  // end of the chunk
  flushOut();                           // see just below
  while (true) {
    var m = self.syncMessage.readMessage(channel, String(msgId++), {}); // blocks here
    if (m == null) continue;
    if (m.eof) { eof = true; return null; }
    buf = encoder.encode(m.data || ""); pos = 0;
    if (buf.length === 0) continue;
    delivering = true; return buf[pos++];
  }
};
```
While the thread is in `Atomics.wait`, **microtasks don't run**. But output is sent to the main thread via a microtask. The `mopsa >> ` prompt (no trailing newline, printed just before the read) would therefore stay stuck in the buffer and the user would see a frozen terminal with no prompt. So we *flush the output synchronously* (`flushOut()`) right before blocking.

On the output side, a `byte sink` collects the stdout/stderr bytes and `postMessage`s them to the main thread (as a *transferable*, to avoid a copy). It normally batches through a microtask, but it also exposes that synchronous `flush()` the read calls before blocking. The same sink serves both modes: interactive sends the raw bytes to `xterm`, DAP reassembles them into `Content-Length` frames.

### The interactive mode, UI side

Inside the WASM, stdin is a **non-tty** char device: `tcgetattr` fails, and MOPSA falls back to line-by-line `Stdlib.read_line`, **with no echo**. If we just relayed the keystrokes, the user wouldn't see anything they type.

So the terminal does **local echo and minimal line editing itself**, then sends the whole line (plus `"\n"`) to stdin on Enter:

```js
for (const ch of data) {
  if (ch === "\r" || ch === "\n") {
    term.write("\r\n");
    session.sendInput(lineRef.current + "\n");
    lineRef.current = "";
  } else if (ch === "\x7f" || ch === "\b") {  // backspace
    // ... erase one character ...
  } else if (ch === "\x03") {                 // Ctrl-C : kill the run
    kill();
  } else if (ch === "\x04") {                 // Ctrl-D  EOF
    session.sendEof();
  } else if (code >= 0x20) {                  // printable char : echo
    lineRef.current += ch; term.write(ch);
  }
}
```

The engine's output (prompts, results, ANSI colors) arrives as raw bytes and is written as-is into `xterm.js`, which renders the 256-color palette natively.

## Misc fixes

Once the `.wasm` runs and analyses terminate, a handful of assumptions scattered across the native dependencies remain that no longer hold on wasm32, they silently compromise the *soundness* of the analysis rather than crashing it.

Apron, for its part, calls `ap_fpu_init` at startup, which probes the FPU via `fesetround(FE_UPWARD)`. On wasm that probe necessarily fails. We short-circuit the function at link time with `-Wl,--wrap=ap_fpu_init`, and our override in `backend/wasm/ap_fpu_wasm.c` (`__wrap_ap_fpu_init`) simply returns `true`. Faking success is safe for the *bound arithmetic*: everything is compiled with `NUM_MPQ`, so bounds are computed with GMP's exact rationals rather than the FPU. It does not make the FPU rounding mode controllable, as noted earlier, floats that reach Apron's API before being converted to rationals can still round the wrong way, so a residual source of unsoundness remains.

Finally, MOPSA's parser runs in two stages: `Clang_to_ml.cc` walks the Clang AST and mirrors each node into an OCaml `value`, then `Clang_to_C.ml` translates that raw Clang AST into MOPSA's own internal C AST (`T_pointer`, `T_record`, …). In 32 bit clang produces types that weren't handled by `Clang_to_C.ml`.

The trigger is `va_list`, whose underlying type Clang picks differently per target.

On **x86-64**, `va_list` is an array: `__va_list_tag[1]`. Like any array passed to a function, it *decays* to a pointer, so it reaches the parser as `__va_list_tag *`. A helper, `fix_va_list`, already recognizes that pattern and folds it back into the `va_list` typedef.

On **32-bit targets** (i386/wasm32), `va_list` is instead a plain scalar, `void *`. And `__builtin_va_start(ap, …)` has to *write back* into the caller's `ap`, so it takes that argument **by reference**. With no decay to hide it, Clang therefore hands the parser a *reference to* `void *`, i.e. an `LValueReferenceType`. `Clang_to_C.ml`'s type translator had no case for reference types, so it fell straight through to its catch-all:

```ocaml
| _ -> error range "unhandled type" (C.string_of_type t)
```

which aborts with `unhandled type: lvalue_ref(__builtin_va_list=void*)`. That blocked parsing of the CPython stub (`share/mopsa/stubs/cpython/Python.c`, `PyErr_Format`'s `va_start`) and therefore all cross C/Python analysis on 32-bit. Since a reference is ABI-equivalent to a pointer, the fix is just to model it as one, right before the catch-all:

```ocaml
(* References are ABI-equivalent to pointers; model them as such. These
   surface in C code via builtins such as __builtin_va_start, whose va_list
   argument is passed by reference when va_list is a scalar (a void
   pointer) on 32-bit targets, unlike x86-64 where it is an array that
   decays to a pointer (see fix_va_list above). *)
| C.LValueReferenceType tq -> T_pointer (type_qual range tq), no_qual
| C.RValueReferenceType tq -> T_pointer (type_qual range tq), no_qual
```

## Acknowledgements

The OCaml WASM port builds on [Vincent Chan](https://github.com/okcdz)'s work on [`ocaml-wasm`](https://github.com/vincentdchan/ocaml) (August 2021), which provided the original `configure` tweaks and the Unix stubs (`unix_lib.c`, `socketaddr.c`, `unixsupport.c`, …) needed to run the OCaml runtime under emscripten.


For compiling LLVM/Clang to wasm, [Binji's fork](https://github.com/binji/llvm-project) and [his notes](https://gist.github.com/binji/b7541f9740c21d7c6dac95cbc9ea6fca) were essential to figuring out how to go about it.

The specific GMP and MPFR versions compatible with emscripten were found thanks to [this Stack Overflow answer](https://stackoverflow.com/a/43583154).
