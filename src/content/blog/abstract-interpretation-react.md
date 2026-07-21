---
title: "Abstract interpretation for React hooks: catching infinite render loops a linter can't see"
description: "Why detecting an infinite render loop is a semantic problem, and how reactant solves it: a concrete semantics (React-tRace), abstract domains, a widening fixpoint, and diagnostics with proof chains."
pubDate: 2026-07-21
draft: true
tags: ["react", "static-analysis", "abstract-interpretation", "rust"]
---

<!--
=====================================================================
PLAN DE TRAVAIL — un seul post, grandes lignes de tout le projet.
Chaque section : angle + points clés + « À détailler » (les endroits où
il faut que TOI tu écrives le fond). Supprimer ce bloc au fur et à mesure.

Fil rouge unique, repris dans chaque section :

    const [n, setN] = useState(null);
    useEffect(() => { setN(n + 1); }, [n]);

Il traverse tout le pipeline : indécidable pour un linter → sémantique
concrète (re-render sur Object.is) → domaine abstrait (null ∪ interval)
→ widening (signal de boucle) → diagnostic avec witness chain.

Conseil d'écriture : rédiger d'abord §3 (domaines) et §4 (widening),
c'est le cœur dense — si le format marche là, le reste suit.
Budget : ~2500–3500 mots. Chaque section de la série originale devient
~1 sous-section ici ; couper est le vrai travail.
=====================================================================
-->

## 1. Why a linter cannot see an infinite render loop

<!-- PLAN
- Ouvrir sur le fil rouge : code de 3 lignes, page qui freeze. ESLint
  (eslint-plugin-react-hooks) ne dit rien — deps array correct, aucune
  règle syntaxique violée.
- Propriété syntaxique vs sémantique : ESLint = reconnaissance de motifs
  AST. « Cette boucle render→effect→setState termine-t-elle ? » =
  propriété du comportement → théorème de Rice → indécidable.
- Sortie : approximation calculable. Interprétation abstraite en un
  paragraphe : sur-approximer l'ensemble des états atteignables ;
  contrat = faux positifs tolérés, faux négatifs interdits.
- Encadré « Claim » (théorème informel) : si l'analyse ne rapporte rien,
  pas de boucle infinie dans le fragment JS couvert. Pas de preuve, un
  sketch et un renvoi vers la section Limites.

À DÉTAILLER PAR TOI :
- Anecdote d'origine du projet ? (pourquoi tu as écrit ça, vrai bug vécu ?)
- Une phrase honnête sur ce que ESLint fait très bien (rules-of-hooks
  lexicales) pour ne pas construire un strawman.
-->

## 2. A concrete semantics to stand on: React-tRace

<!-- PLAN
- LA thèse différenciatrice (ADR-001) : sans sémantique concrète C
  explicite, pas de soundness établissable — les transfer functions
  deviennent du guesswork. La plupart des outils JS sautent cette étape.
- React-tRace (Lee, Ahn, Yi — OOPSLA 2025, arXiv:2507.05234) : seule
  formalisation publique de useState/useEffect avec preuve de
  conformance. Citer proprement, lien arXiv.
- Render loop = système de transitions : StepInit → StepEffect →
  StepCheck ; les règles SttReBind / CheckEffect définissent exactement
  les conditions de re-render → correspond directement à l'itération de
  point fixe de l'analyseur.
- L'interpréteur OCaml du papier sert d'oracle de test : l'analyseur
  doit sur-approximer ses traces sur les exemples du papier.
- Honnêteté : React-tRace couvre useState/useEffect sans deps array ;
  les extensions (deps, useMemo, useCallback, useRef) sont spécifiées
  localement (docs/semantics.md) sans garantie formelle équivalente.

À DÉTAILLER PAR TOI :
- Dérouler le fil rouge dans la sémantique concrète : trace pas-à-pas
  n=null → 1 (NaN? non : null+1 = 1 via coercion... vérifier et raconter
  la coercion JS ici, elle re-servira en §3) → 2 → 3 → Object.is diffère
  à chaque check → re-render infini.
- Un mini-diagramme du cycle StepInit/StepEffect/StepCheck (mermaid).
-->

## 3. Abstract domains: where the real design problem lives

<!-- PLAN
- Message central : le vrai problème n'est pas le code, c'est le design
  du domaine. Raconter l'arc ADR-008 → ADR-015 comme un récit d'erreur
  instructive — c'est le meilleur matériau pédagogique du projet.
- 3a. Lattice Stability (ADR-002) : 4 points, diagramme ASCII repris tel
  quel (⊤ Unknown / Stable / Unstable / ⊥). React compare avec
  Object.is → la stabilité de référence EST la propriété métier.
  Tableau de transfer functions abrégé (3–4 lignes marquantes :
  object literal → Unstable, setter → Stable, useMemo → join(deps)).
- 3b. Le piège du domaine plat (ADR-008) : StateValue enum, un état JS
  = un seul kind. join(Null, Number([1,1])) = Top → sur useState(null),
  toute la progression [1,2,3,…] disparaît → faux négatif sur le fil
  rouge. Trois mécanismes compensatoires empilés (TypedStateStore,
  infer_state_type, type_hint useState<T>) — et le FN reste documenté.
- 3c. La sortie (ADR-015) : les kinds JS sont disjoints → l'union
  dégénère en produit pointwise. StateValue devient un struct :
  { num: Interval, str: StrConst, null: bool, reference: Stability, … },
  join/widen slot par slot. null ∪ number[0,+∞) reste précis, le slot
  num continue de widener. Les 3 hacks sont SUPPRIMÉS, pas contournés.
  Bonus élégant : ToNumber(null) = 0 (vraie sémantique JS) → le compteur
  useState(null) non annoté, ancien FN, devient une détection positive.
- Formalisation légère : définitions join/⊑ pointwise, une phrase sur
  la terminaison (chaque slot fini ou à widening propre). Dire
  honnêtement : soundness par construction depuis les règles
  React-tRace, pas de connexion de Galois complète ni preuve mécanisée.

À DÉTAILLER PAR TOI :
- Le récit temporel : combien de temps le domaine plat a tenu, qu'est-ce
  qui a déclenché la refonte (le test null_init_without_hint... ?).
- Choisir : montrer le struct Rust réel ou une version simplifiée ?
  (je recommande le réel, il est court et c'est un post technique).
- Diagramme : les deux lattices côte à côte (enum plat vs produit).
-->

## 4. The fixpoint, widening up-to, and an accidental negative result

<!-- PLAN
- Signal de détection : dans le fixpoint du SCC Effect→State→Effect, si
  un slot WIDEN (croît sans converger) → boucle potentielle ; si
  convergence sans widening → pas de boucle. C'est LE mécanisme central,
  le dire en une phrase encadrée.
- Widening naïf = saut à ±∞ dès qu'une borne bouge → un compteur GARDÉ
  `if (count < 10) setCount(count + 1)` devient [0,+∞) → faux positif.
- Widening up-to (ADR-014, style ASTRÉE) : thresholds = littéraux des
  gardes + inits useState, récoltés avant le fixpoint. Une borne qui
  croît saute au plus petit threshold englobant, ±∞ seulement au-delà.
  Exemples chiffrés de l'ADR : `if (count < 10)` → [0,10] ;
  `while (i < 5)` → [0,5] à la sortie [5,5].
- LE mini-résultat publiable (format « negative result », le vendre
  comme tel) : le narrowing classique (phase descendante) est redondant
  dans ce setting. Deux raisons :
  (1) narrowing et threshold widening ne récupèrent tous deux QUE des
  bornes littérales concrètes — le widening up-to les capture déjà en
  phase ascendante ;
  (2) la phase descendante ne peut de toute façon rien tirer du state
  store : les écritures des setters s'accumulent par join monotone.
  Décision : opérateur narrow non implémenté, infra différée.
- Soundness en 2 phrases : threshold widening reste un widening valide
  (résultat ⊒ join des opérandes, ensemble de thresholds fini →
  terminaison).

À DÉTAILLER PAR TOI :
- Reprendre le fil rouge : useState(null) + setN(n+1) SANS garde →
  [0,0] → [0,1] → widening → [0,+∞) → flag. Puis la variante gardée qui
  converge à [0,10] → silence. Deux traces d'itérations côte à côte,
  c'est la figure la plus parlante du post.
- Éventuellement : nombre d'itérations réel, temps d'analyse sur un
  composant type (chiffre concret = crédibilité).
-->

## 5. From "the fixpoint widened" to a diagnostic a human can read

<!-- PLAN
- Problème : « fixpoint diverged on label 3 » n'est pas un message
  d'erreur. Deux mécanismes pour remonter à l'humain :
- 5a. Graphe de cycles d'effets (ADR-018) : les boucles multi-effets
  (setB({from: a}) dans un effet, setA({from: b}) dans l'autre) sont
  invisibles au widening (références : pas de croissance numérique).
  Graphe sur slots qualifiés (component, hook), arête x→y = « un
  changement de x re-lance un effet qui écrit une référence fraîche
  dans y », cycle = boucle auto-entretenue. Tarjan SCC, deux passes :
  sous-graphe must-only → Error ; graphe complet → Warning.
- 5b. Witness chains (ADR-019) : vocabulaire clos de steps typés
  (Write → CycleEdge → Widen…), chaque step ancré (file, line, col),
  provenance enregistrée au moment où l'engine SAIT (widen_trace,
  inline_origins) au lieu d'être re-dérivée par les règles. Pas de
  variant Text(String) — anecdote de design à raconter : un escape
  hatch texte libre aurait re-érodé le vocabulaire en prose en
  quelques mois.
- Niveaux de sévérité = conséquence directe du contrat de soundness :
  certain (chaîne all-must) → Error ; sur-approximation incertaine →
  Warning ; Info = marqueur d'imprécision résiduelle. Ce n'est pas une
  convention UX, c'est le contrat FP/FN rendu visible.

À DÉTAILLER PAR TOI :
- Montrer une vraie sortie CLI avec --trace sur le fil rouge (copier la
  sortie réelle, comme le README).
- Le cycle deux-effets en exemple complet (8 lignes de code + le
  diagnostic Error avec le chemin `a` → `b` → `a`).
-->

## 6. Limits, honestly

<!-- PLAN
- Fragment JS couvert (sous-ensemble contrôlé, pas tout TS/JS).
- Extensions hors React-tRace sans garantie formelle ; pas de preuve
  mécanisée ; soundness « par construction ».
- FN résiduels connus : callbacks auto-run (.then) dans effets no-deps,
  FieldAccess dégradé en Unknown qui perd des arêtes cross-component.
- FP par design : paires multi-writer gardées qui convergent en vrai
  (Warning assumé).
- Corpus : 4 repos, pas de nouveaux FP après ADR-018 — donner le
  chiffre, dire ce que le corpus ne couvre pas.
- Positionnement : complément d'eslint-plugin-react-hooks, pas un
  remplaçant (plus lent, whole-program). « Use both. »

À DÉTAILLER PAR TOI :
- Stats corpus réelles (taille des repos, temps d'analyse, nb de
  diagnostics vrais/faux) si tu les as.
-->

## Notes de forme (à supprimer)

<!--
- Encadrés « Claim » : théorèmes informels + sketch, jamais de preuve
  complète. Un par section max.
- Chaque section technique se ferme sur UNE phrase de limite — la
  section 6 les rassemble, ça évite l'effet « survente puis douche ».
- Diagrammes : (1) cycle StepInit/Effect/Check, (2) lattice Stability,
  (3) enum plat vs produit pointwise, (4) traces d'itérations widening
  gardé/non-gardé, (5) graphe de cycle 2 effets. Mermaid natif dans le
  blog ? sinon SVG comme mopsa_deps.svg.
- Citations : React-tRace (Lee, Ahn, Yi, OOPSLA 2025) + lien vers les
  ADRs publics du repo (le lecteur académique adore les décisions
  tracées) + lien repo GitHub.
- Ce qu'on COUPE volontairement du projet pour tenir en un post : IR/CFG
  (ADR-003), heap model (ADR-010), cross-file inlining (ADR-013),
  Versioned stability (ADR-017), plugin API. Une ligne « the analyzer
  also does X, Y, Z » avec liens ADRs suffit — chacun est un post
  futur potentiel si celui-ci marche.
-->
