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

Compiler `ocamlrun` en WebAssembly ne suffit pas : encore faut-il que l'interpréteur retrouve, à l'exécution, le code C derrière chaque `external` du bytecode. Et c'est là que ça se complique, parce que **OCaml résout ses primitives C dynamiquement** — un mécanisme qui n'a aucun sens dans un navigateur.

### Comment OCaml lie ses primitives, normalement

Quand vous écrivez `external foo : int -> int = "caml_foo"`, le compilateur n'émet jamais d'appel direct à `caml_foo`. Il lui attribue un **numéro** et émet une instruction `C_CALLn <index>`. Tout le binding nom → adresse est repoussé au démarrage du programme.

Un exécutable bytecode embarque pour cela trois sections :

- `PRIM` — la liste ordonnée des **noms** de primitives référencées (`caml_foo`, `unix_read`, …) ;
- `DLLS` — la liste des bibliothèques partagées qui les fournissent (`dllunix.so`, …) ;
- `DLPT` — les chemins où chercher ces `.so`.

Au lancement, `caml_build_primitive_table` (dans `runtime/dynlink.c`) déroule la mécanique :

1. il `dlopen`e chaque `.so` listé dans `DLLS` ;
2. pour chaque nom de `PRIM`, il appelle `dlsym` sur ces bibliothèques pour récupérer l'adresse réelle de la fonction ;
3. il range ces pointeurs, dans l'ordre, dans un tableau `caml_prim_table`.

À l'exécution, `C_CALLn <index>` n'est plus qu'un `caml_prim_table[index](args)`. Le nom a disparu, il ne reste qu'un indice dans un tableau de pointeurs.

Sauf qu'en WASM, **il n'y a ni `dlopen`, ni `.so`, ni fichiers de bibliothèques natives à charger**. Toute cette résolution dynamique est morte-née. Il faut la remplacer par un binding entièrement statique — décidé au moment du link, pas au runtime.

### La porte de sortie : `caml_builtin_cprim` et `prims.o`

Bonne nouvelle : OCaml prévoit déjà ce cas. Avant de fouiller dans les `.so`, `lookup_primitive` regarde d'abord une **table statique** compilée dans le runtime lui-même :

```c
static c_primitive lookup_primitive(char * name)
{
  /* 1. table built-in, liée statiquement */
  for (int i = 0; caml_names_of_builtin_cprim[i] != NULL; i++)
    if (strcmp(name, caml_names_of_builtin_cprim[i]) == 0)
      return caml_builtin_cprim[i];
  /* 2. seulement ensuite, les .so chargés dynamiquement */
  for (int i = 0; i < shared_libs.size; i++) {
    void * res = caml_dlsym(shared_libs.contents[i], name);
    if (res != NULL) return (c_primitive) res;
  }
  return NULL;
}
```

Ces deux tableaux — `caml_builtin_cprim[]` (les pointeurs) et `caml_names_of_builtin_cprim[]` (les noms) — sont exactement ce que produit `ocamlc -custom` : un fichier généré, classiquement appelé `prims.c`, qui déclare toutes les primitives de l'exécutable et les range dans ces deux tables. C'est le mode « tout statique » d'OCaml, prévu à l'origine pour produire des exécutables sans dépendance aux `dll*.so`.

**C'est précisément sur ce point d'entrée que je me greffe.** Je fournis mon propre `prims.c` contenant *toutes* les primitives dont le bytecode de Mopsa a besoin, et je neutralise dans le runtime la branche `dlopen` — qui de toute façon n'a rien à charger. Le patch tient en quelques lignes commentées dans `caml_build_primitive_table` :

```c
caml_ext_table_init(&shared_libs, 8);
// wasm: shared libraries are not supported, skip open_shared_lib
// if (libs != NULL)
//   for (p = libs; *p != 0; p += strlen_os(p) + 1)
//     open_shared_lib(p);
```

`shared_libs` reste donc vide en permanence. La seconde boucle de `lookup_primitive` (le `dlsym`) ne trouve jamais rien : **chaque primitive doit être présente dans ma table built-in**, sinon le runtime s'arrête net sur `unknown C primitive`. Le binding dynamique est devenu statique sans toucher au contrat : mêmes noms, même indexation issue de la section `PRIM`.

### Fabriquer `prims.o` : extraire les primitives

Mon `prims.c` est généré à partir d'une simple liste de noms, `primitives.txt`, et de trois lignes de `sed` dans le Makefile :

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

Le fichier généré ressemble à ça :

```c
extern value caml_array_get();
extern value unix_read();
/* … 1435 lignes … */

c_primitive caml_builtin_cprim[] = {
    caml_array_get, unix_read, /* … */ 0 };

char * caml_names_of_builtin_cprim[] = {
    "caml_array_get", "unix_read", /* … */ 0 };
```

Chaque primitive est déclarée `extern value foo();` — sans prototype d'arguments. Leurs signatures réelles diffèrent (arités 1 à 5, plus `N`), mais c'est sans conséquence : l'interpréteur recaste systématiquement le pointeur à la bonne arité au moment de l'appel (`Primitive1(n)`, `Primitive2(n)`, … dans `prims.h`). D'où le `-Wno-incompatible-function-pointer-types` qui fait taire l'avertissement attendu.

Reste la vraie question : comment construire `primitives.txt` ? La table doit être un **sur-ensemble** de tout ce que le bytecode appelle. Je récupère donc les primitives en scannant les sources C/C++ — celles du runtime *et* de chaque bibliothèque que je lie — avec un petit script, `extract-primitives.js`. Il reprend l'idée du `gen_primitives.sh` d'OCaml (`sed -n 's/^CAMLprim value \(…\)/\1/p'`) mais en plus robuste, parce que les sources de Mopsa et d'Apron ne se contentent pas de `CAMLprim value foo(...)`. Il sait reconnaître :

- les qualificatifs intercalés (`CAMLweakdef`, `extern "C"`, …) ;
- le raccourci `CAMLprim_int64_N(name)` → `caml_int64_<name>` + `caml_int64_<name>_native` ;
- les **macros à collage de jetons** (`#define FOO(X) CAMLprim … prefix_##X(…)`), qu'il développe à leur point d'invocation ;
- les stubs générés par CamlIDL, déclarés en `value foo(value a, value b, …)` sans `CAMLprim` ;
- en C++, le fait qu'une vraie primitive doit avoir une *linkage* `extern "C"` (pour ne pas embarquer des méthodes de classe).

Le résultat, ~1435 primitives, est l'union de plusieurs mondes : le cœur du runtime (`caml_*`), `unix` (131 primitives), `str`, `bigarray`/`int64`, et surtout les **655 stubs Apron générés par CamlIDL** (`camlidl_*_ap_*`). Je commit `primitives.txt` tel quel ; à l'occasion je le recoupe avec `strings build/mopsa.bc` pour vérifier qu'il couvre bien la section `PRIM` réelle du bytecode.

### Ce que je ne compile pas dans `libcamlrun`

Le runtime, lui, je le veux le plus nu possible. Deux décisions vont dans ce sens.

D'abord, `configure` désactive tout ce qui n'a aucun sens en WASM ou que je n'utilise pas :

```sh
emconfigure ./configure --disable-native-compiler --disable-ocamltest \
                        --disable-ocamldoc --disable-systhreads
```

Pas de compilateur natif (on n'interprète que du bytecode), pas de threads système, et — via le patch décrit plus haut — pas de chargement dynamique.

Ensuite, et c'est le point important : **les stubs C des bibliothèques (`unix`, `str`) ne sont pas patchés dans l'arbre du runtime** (`deps/ocaml-wasm`). Je les garde comme unités de compilation autonomes dans `deps/primitives/{unix,str}`, assemblées à part dans `libmopsa_primitives.a`. Ça garde le fork OCaml minimal et facile à rebaser sur une version amont ultérieure. Au passage, j'ai aussi écarté `systhreads`, `integers`, `ctypes` et `core_kernel` qui traînaient dans le fork d'origine : un `strings build/mopsa.bc` confirme que le bytecode de Mopsa ne référence aucune de leurs primitives, donc elles n'ont pas à exister dans la table.

### L'intégration finale : tout en statique

Le link final d'emscripten rassemble tout dans un unique `ocamlrun.wasm` :

```make
$(EMCC) ... -o $(DIST_DIR)/ocamlrun.js \
    --preload-file $(BUILD_DIR)/mopsa.bc@/build/mopsa.bc \
    $(DEPS_BIN_DIR)/*.a $(LIBS_DIR)/*.a \
    -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
    $(BUILD_DIR)/prims.o $(BUILD_DIR)/libcamlrun.a
```

Trois choses à noter :

- **Tout est lié statiquement** : `libcamlrun.a` (l'interpréteur), `prims.o` (la table de primitives), et l'ensemble des archives `.a` — GMP, MPFR, Apron, le runtime CamlIDL, les stubs OCaml d'Apron (box/oct/polka), Zarith, Clang/LLVM, le parseur C de Mopsa, et mes `libmopsa_primitives.a` (unix + str). C'est ce qui donne un `.wasm` autonome de ~15 Mo.
- `ERROR_ON_UNDEFINED_SYMBOLS=1` est mon filet de sécurité : il garantit que **chaque symbole nommé dans `caml_builtin_cprim[]` correspond bien à une fonction réellement présente** dans l'une des archives. Si `primitives.txt` cite une primitive que personne ne fournit, le link wasm échoue bruyamment — plutôt qu'un `unknown C primitive` au runtime, dans le navigateur, au pire moment.
- **`mopsa.bc` n'est pas lié** : il est *préchargé* dans le système de fichiers virtuel d'emscripten, puis interprété au runtime par `ocamlrun`. C'est du bytecode, pas du code natif.

La boucle est bouclée : le bytecode appelle une primitive par son index → au démarrage, `caml_prim_table` est rempli depuis `caml_builtin_cprim[]` sans le moindre `dlopen` → et ces symboles pointent vers du code C statiquement lié dans l'unique `ocamlrun.wasm`. Le mécanisme dynamique d'OCaml a été entièrement remplacé par une résolution figée au link, ce qui est exactement ce qu'attend un binaire WebAssembly.

## 4. The core fight: OCaml values across the FFI boundary on wasm32

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
