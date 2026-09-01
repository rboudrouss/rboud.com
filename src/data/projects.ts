export interface Project {
  name: string;
  links: { label: string; href: string }[];
  description: { en: string; fr: string };
  tags: string[];
}

export const projects: Project[] = [
  {
    name: "Reactant",
    links: [
      { label: "GitHub", href: "https://github.com/rboudrouss/reactant-analyzer" },
      { label: "npm", href: "https://www.npmjs.com/package/reactant-analyzer" },
    ],
    description: {
      en: "Static analyzer for React hook bugs, based on abstract interpretation over a dedicated CFG-based IR. The analysis is whole-program, with setters tracked through the call graph and custom hooks inlined across files, which catches what AST linters cannot see: infinite render loops, derived state, stale closures, cross-component cycles. 17 rules, shipped as a Rust CLI, a WebAssembly npm package and a GitHub Action.",
      fr: "Analyseur statique de bugs de hooks React, fondé sur l'interprétation abstraite d'une IR dédiée à base de CFG. L'analyse est globale, les setters sont suivis dans le graphe d'appels et les hooks personnalisés inlinés entre fichiers, ce qui permet de détecter ce que les linters syntaxiques ne voient pas : boucles de rendu infinies, état dérivé, closures obsolètes, cycles entre composants. 17 règles, distribué comme CLI Rust, paquet npm WebAssembly et action GitHub.",
    },
    tags: ["Rust", "Static Analysis", "Abstract Interpretation", "WebAssembly", "React"],
  },
  {
    name: "Mopsa WASM",
    links: [
      { label: "GitHub", href: "https://github.com/rboudrouss/mopsa-emcc" },
      { label: "Live", href: "https://mopsawasm.rboud.com/" },
    ],
    description: {
      en: "Full port of the MOPSA static analyzer (OCaml/C/C++) to WebAssembly with a web frontend. Compiles the entire toolchain (including Clang) to run analysis directly in the browser.",
      fr: "Portage complet de l'analyseur statique MOPSA (OCaml/C/C++) en WebAssembly avec une interface web. Compile toute la chaîne d'outils (Clang inclue) pour exécuter l'analyse directement dans le navigateur.",
    },
    tags: ["OCaml", "C/C++", "WebAssembly", "Clang", "Emscripten"],
  },
  {
    name: "Glyph",
    links: [
      { label: "GitHub", href: "https://github.com/PlaySorbonne/glyph" },
      { label: "Live", href: "https://glyph.playsorbonne.fr" },
    ],
    description: {
      en: "Web app for a real-world treasure hunt built in collaboration with multiple Sorbonne University departments. Helps new students discover the campus through an interactive quest experience.",
      fr: "Application web pour un jeu de piste grandeur nature, développée en collaboration avec plusieurs services de Sorbonne Université. Permet aux nouveaux étudiants de découvrir le campus à travers des quêtes interactives.",
    },
    tags: ["TypeScript", "Next.js", "PostgreSQL"],
  },
  {
    name: "Play Sorbonne, site vitrine",
    links: [
      { label: "GitHub", href: "https://github.com/PlaySorbonne/psu_site" },
      { label: "Site", href: "https://playsorbonne.fr/" },
    ],
    description: {
      en: "Showcase website for the Play Sorbonne University student association. 9,000+ unique visitors in 2025, with on-page SEO and analytics.",
      fr: "Site vitrine de l'association étudiante Play Sorbonne Université. 9 000+ visiteurs uniques en 2025, avec SEO on-page et analytics.",
    },
    tags: ["Astro"],
  },
];
