export interface Project {
  name: string;
  links: { label: string; href: string }[];
  description: { en: string; fr: string };
  tags: string[];
}

export const projects: Project[] = [
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
