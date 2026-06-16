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

## Compiling the ocaml runtime

La compilation du runtime est assez directe, modulo un petit soucis. OCaml 4.14 a introduit `runtime/sak`, un outil exécuté sur le host pour encoder le chemin de la stdlib dans un littéral C. `emconfigure` le compile avec `emcc` et produit un `.wasm` impossible à exécuter nativement, le build continue silencieusement, le chemin reste vide, et l'échec n'arrive qu'à l'exécution. pour résoudre ça je compile `sak` manuellement avec le vrai `cc` avant de lancer `make`.

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

Le répertoire `runtime/` contient les headers `<caml/*.h>` qui définissent l'API FFI d'OCaml, les mêmes dont dépendent tous les stubs C qu'on va compiler ensuite. Toutes les compilations ultérieures qui touchent au FFI passent donc `-I$(OCAML_STDLIB)`, ce qui pointe vers ce même `runtime/`. Ça garantit que les stubs sont compilés contre les définitions exactes du runtime qui les exécutera.


## Compiling CamlIDL based stubs

CamlIDL est un générateur de stubs. On lui donne un fichier `.idl` décrivant un ensemble de types et fonctions C, et il produit deux choses : `foo_stubs.c`, qui contient les fonctions C qui convertissent les valeurs OCaml vers C et inversement, et `foo.ml`/`foo.mli`, qui est l'API OCaml. L'idée est de ne jamais écrire la tuyauterie de conversion à la main.

Deux dépendances de MOPSA s'appuient là-dessus énormement : **mlgmpidl** (bindings OCaml pour GMP et MPFR) et **mlapronidl** (bindings OCaml pour les domaines abstraits d'Apron). Ensemble, ils représentent environ 655 des ~1435 primitives de la table finale.

### CamlIDL runtime

`camlidl` s'éxecute au moment de la compulation pur générer les fichiers `.ml` et `.c` nécessaire. Sauf que tout les fichiers générés reposes sur le `CamlIDL runtime` qui est un ensemble de 3 fichiers (`idlalloc.c`, `comintf.c` et `comerror.c`) qui fournissent des utils pour les codes générés, notamment l'allocation mémoire et des utilitaires d'interfaces...

Voici la commande dans le makefile utilisé pour complisé ces fichiers

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

On notera l'option `-I$(OCAML_STDLIB)`, c'est le chemin vers les headers de la FFI OCaml, ceux du runtime qu'on vient de compiler. Elle est nécessaire pour deux raisons : ces fichiers camlidl appellent les fonctions de la FFI, et leurs headers doivent être précisément ceux, spécifiques, du runtime qui sera amené à exécuter.

### mlgmpidl

mlgmpidl encapsule les entiers GMP (`mpz_t`), les rationnels (`mpq_t`), les flottants (`mpf_t`), les nombres MPFR (`mpfr_t`) et l'état aléatoire — six modules au total. Son build est autonome : son propre Makefile sait piloter `camlidl`. Un simple `make *.c` exécute `camlidl` et son post-traitement Perl, produisant les fichiers `.c` que je compile ensuite un par un avec `emcc` :

```make
$(LIBS_DIR)/libgmp_caml.a: $(LIBS_DIR)/libgmp.a $(LIBS_DIR)/libmpfr.a $(LIBS_DIR)/libcamlidl.a
    cd $(DEPS_DIR)/mlgmpidl
    CFLAGS="$(CFLAGS)" $(EMCONFIGURE) ./configure \
        -prefix $(INSTALL_DIR) -gmp-prefix $(INSTALL_DIR) -mpfr-prefix $(INSTALL_DIR)
    CFLAGS="$(CFLAGS)" $(MAKE) $(MLGMPIDL_MODULES:%=%.c)
    for module in $(MLGMPIDL_MODULES); do
        $(EMCC) $(EMCC_FLAGS) -c -I$(OCAML_STDLIB) -I$(INSTALL_DIR)/include \
            $${module}.c -o $(BUILD_DIR)/$${module}.o
    done
    $(EMAR) rcs $(LIBS_DIR)/libgmp_caml.a $(addprefix $(BUILD_DIR)/,$(MLGMPIDL_MODULES:%=%.o))
```

Aucun post-traitement nécessaire. Les stubs sortent de `camlidl` déjà compatibles avec la version d'OCaml utilisée.

### mlapronidl

Les bindings OCaml d'Apron — `mlapronidl` — couvrent 18 modules IDL décrivant chaque concept de domaine abstrait : scalaires, intervalles, expressions linéaires, contraintes linéaires, générateurs, expressions arborescentes, managers, et les valeurs abstraites elles-mêmes (niveau 0 brut et niveau 1 avec environnements). C'est là que réside la majorité de la surface FFI d'Apron.

La compilation est plus complexe que mlgmpidl parce que les fichiers IDL de `mlapronidl` ont été écrits pour un ancien couple `camlidl`/OCaml. Lancer `camlidl` directement produirait des stubs qui ne compilent pas proprement. Le correctif vient de deux scripts Perl fournis par le dépôt Apron : `perlscript_c.pl` réécrit le `.c` généré, `perlscript_caml.pl` réécrit le `.ml`/`.mli` généré.

```make
for idl in $(MLAPRONIDL_IDL); do
    $(CAMLIDL) -no-include -prepro "$(PERL) macros.pl" $$idl.idl && \
    $(PERL) perlscript_c.pl    < $${idl}_stubs.c > $${idl}_caml.c && \
    $(PERL) perlscript_caml.pl < $$idl.ml        > $$idl.ml.tmp && mv $$idl.ml.tmp $$idl.ml && \
    $(PERL) perlscript_caml.pl < $$idl.mli       > $$idl.mli.tmp && mv $$idl.mli.tmp $$idl.mli
done
for module in $(MLAPRONIDL_MODULES); do
    $(EMCC) $(EMCC_FLAGS) -c $(CAMLIDL_CFLAGS) \
        -I$(DEPS_DIR)/apron/apron -I$(DEPS_DIR)/apron/mlapronidl \
        -o $(BUILD_DIR)/$${module}.o $(DEPS_DIR)/apron/mlapronidl/$${module}.c
done
$(EMAR) rcs $@ $(addprefix $(BUILD_DIR)/,$(MLAPRONIDL_MODULES:%=%.o))
```

`CAMLIDL_CFLAGS` contient notamment `-I$(OCAML_STDLIB)`, qui pointe vers les headers du runtime OCaml dans `deps/ocaml-wasm/runtime` — les stubs seront exécutés par ce même runtime, ils doivent donc être compilés contre ses headers pour que les deux s'accordent.

Chaque domaine numérique (box, octagones, polka) obtient ensuite sa propre archive, compilée avec `-DNUM_MPQ` :

```make
$(EMCC) $(EMCC_FLAGS) -c $(CAMLIDL_CFLAGS) \
    -I$(DEPS_DIR)/apron/box -DNUM_MPQ \
    -o $(BUILD_DIR)/box_caml.o $(DEPS_DIR)/apron/box/box_caml.c
$(EMAR) rcs $(DEPS_BIN_DIR)/libboxMPQ_caml.a $(BUILD_DIR)/box_caml.o
```

`NUM_MPQ` indique à Apron d'utiliser les rationnels multi-précision exacts de GMP (`mpq_t`) plutôt que des `double` matériels pour toutes les bornes. Les domaines flottants d'Apron s'appuient normalement sur `fesetround` pour contrôler l'arrondi vers le haut/bas au niveau matériel — et WebAssembly n'a aucun contrôle de mode d'arrondi FPU. Avec `NUM_MPQ`, chaque borne est calculée exactement via GMP et `fesetround` n'est jamais nécessaire.


## Compiling LLVM/Clang 9

- two-stage cross-compile: native `llvm-tblgen` / `clang-tblgen` first, then the wasm libs (~30 min, RTTI/EH off)
- list of retained Clang libs
- `Clang_to_ml.cc`: the C++→OCaml values bridge, and the Clang resource headers preloaded into the virtual FS

## The final link: everything static

emscripten's final link pulls everything into a single `ocamlrun.wasm`:

```make
$(EMCC) ... -o $(DIST_DIR)/ocamlrun.js \
    --preload-file $(BUILD_DIR)/mopsa.bc@/build/mopsa.bc \
    $(DEPS_BIN_DIR)/*.a $(LIBS_DIR)/*.a \
    -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
    $(BUILD_DIR)/prims.o $(BUILD_DIR)/libcamlrun.a
```

Three things worth noting:

- **Everything is statically linked**: `libcamlrun.a` (the interpreter), `prims.o` (the primitive table), and all the `.a` archives — GMP, MPFR, Apron, the CamlIDL runtime, the OCaml Apron stubs (box/oct/polka), Zarith, Clang/LLVM, MOPSA's C parser, and my `libmopsa_primitives.a` (unix + str). That's what yields a self-contained `.wasm` of ~15 MB.
- `ERROR_ON_UNDEFINED_SYMBOLS=1` is my safety net: it guarantees that **every symbol named in `caml_builtin_cprim[]` actually exists** in one of the archives. If `primitives.txt` names a primitive that nothing provides, the wasm link fails loudly — rather than hitting `unknown C primitive` at runtime, in the browser, at the worst possible moment.
- **`mopsa.bc` is not linked**: it is *preloaded* into emscripten's virtual filesystem, then interpreted at runtime by `ocamlrun`. It's bytecode, not native code.

The loop is closed: the bytecode calls a primitive by index → at startup, `caml_prim_table` is filled from `caml_builtin_cprim[]` without a single `dlopen` → and those symbols point to C code statically linked into the single `ocamlrun.wasm`. OCaml's dynamic mechanism has been entirely replaced by a resolution frozen at link time — which is exactly what a WebAssembly binary expects.

## 4. The core fight: OCaml values across the FFI boundary on wasm32

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
