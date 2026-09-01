export interface Talk {
  title: string;
  event: { en: string; fr: string };
  period: { en: string; fr: string };
  links: { label: string; href: string }[];
  description: { en: string; fr: string };
}

export const talks: Talk[] = [
  {
    title: "Compiling FFI-heavy OCaml to WebAssembly: An Experience Report on MOPSA",
    event: {
      en: "OCaml Workshop 2026 · INRIA Paris",
      fr: "OCaml Workshop 2026 · INRIA Paris",
    },
    period: { en: "Aug. 2026", fr: "Août 2026" },
    links: [
      {
        label: "Slides",
        href: "https://github.com/rboudrouss/articles/blob/main/Ocaml-Workshop-2026/slides/slides.pdf",
      },
      { label: "Workshop", href: "https://ocaml.org/ocaml-workshop-2026" },
    ],
    description: {
      en: "Talk on porting MOPSA, an OCaml analyzer built on a large native stack (LLVM/Clang, GMP, MPFR, Apron, CamlIDL bindings), to the browser. Instead of translating the OCaml code like the existing web backends do, the bytecode runtime and the whole dependency stack are compiled to WebAssembly with Emscripten, and the unmodified bytecode is interpreted on top, so no FFI stub has to be rewritten.",
      fr: "Présentation sur le portage de MOPSA, analyseur OCaml reposant sur une large pile native (LLVM/Clang, GMP, MPFR, Apron, bindings CamlIDL), vers le navigateur. Plutôt que de traduire le code OCaml comme le font les backends web existants, le runtime bytecode et toute la pile de dépendances sont compilés en WebAssembly avec Emscripten, et le bytecode non modifié est interprété par-dessus, ce qui évite de réécrire les stubs FFI.",
    },
  },
];
