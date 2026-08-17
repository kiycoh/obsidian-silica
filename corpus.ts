// The lexical substrate every offline feature stands on: one pass over the vault
// turns each markdown file into a {stem: count} row. Port of
// silica/kernel/text/text.py:tokens plus cooccurrence.build_contribution's node
// half (the edge half is not needed here — CORRELATE works off counts alone).
//
// Structural types only, no Obsidian import, so `node --test` can drive it.

export interface CorpusFile {
  path: string;
  basename: string;
  stat: { mtime: number };
}

export interface CorpusVault {
  getMarkdownFiles(): CorpusFile[];
  cachedRead(file: CorpusFile): Promise<string>;
}

export interface Corpus {
  /** path -> {stem: count}. The source of truth; everything else is derived. */
  counts: Map<string, Map<string, number>>;
  /** path -> mtime the row was built from, so a rebuild only re-reads what moved. */
  mtimes: Map<string, number>;
  /** stem -> {path: count}. Derived, rebuilt on every refresh (a map walk). */
  postings: Map<string, Map<string, number>>;
  /** path -> total token count, and the corpus mean, for BM25's length term. */
  lengths: Map<string, number>;
  avgLen: number;
  /** Basename of each indexed path, for result rows that show a title. */
  titles: Map<string, string>;
  /** Paths that take no part in the pairwise layer (related, edges, attention).
   * Still indexed: search is asked for, relatedness is inferred, and the whole
   * point of excluding a journal folder is silencing the inference. */
  excluded: Set<string>;
  lang: Lang;
}

export type Lang = "en" | "it";

// ponytail: a 200k-char ceiling per note. A vault of transcripts should not make
// the first index build take a minute; raise it if a real note gets truncated.
const MAX_CHARS = 200_000;
const MIN_TOKEN_LEN = 3; // mirrors kernel/text/text.py MIN_TOKEN_LEN

// Two stopword sets, not the fifteen Snowball has. Detection below picks one per
// vault; an unlisted language falls through to `en`, whose set is nearly inert on
// non-English prose, so the worst case is noisier stems, never a crash.
const STOPWORDS: Record<Lang, Set<string>> = {
  en: new Set(
    ("the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many over such take than them well were what will would there their which about could other into more only your after also back because before between both down each even first from most must never other same should still take these those through under until where while would".split(
      " ",
    )),
  ),
  it: new Set(
    ("che non per con una del della delle dei degli nel nella nelle nei negli sul sulla come piu meno anche quando dove perche quale quali questo questa questi queste quello quella quelli quelle sono stato stata stati state essere avere fatto fare dopo prima ancora sempre mai ogni altro altra altri altre tutto tutta tutti tutte molto poco solo gli agli dal dalla dalle dai dagli suo sua suoi sue mio mia miei mie loro nostro nostra vostro cosa senza sotto sopra tra fra oltre quindi allora infatti invece mentre poi cui chi cui era erano sarà sara essa esso esse essi".split(
      " ",
    )),
  ),
};

// Letters of any script (the JS twin of kernel/text/language.py's _TOKEN_RE).
// \p{L} needs the u flag; ES2018 targets support it.
export const TOKEN_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;

/** Argmax over stopword hits, exactly language.detect's classifier. Ties and an
 * empty sample resolve to "en" because it is tested first. */
export function detectLang(sample: string): Lang {
  let best: Lang = "en";
  let bestHits = 0;
  for (const lang of ["en", "it"] as Lang[]) {
    const words = STOPWORDS[lang];
    let hits = 0;
    for (const m of sample.toLowerCase().matchAll(TOKEN_RE)) if (words.has(m[0])) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = lang;
    }
  }
  return best;
}

// ponytail: a light suffix stripper, not Snowball. Silica gated CORRELATE's
// tau=0.25 on Snowball stems, so this trades a little recall for zero runtime
// dependencies (the plugin ships with an empty `dependencies` block and that is
// worth keeping). Bundle snowball-stemmers if related-notes quality disappoints.
// Verb/adverb endings, longest first. A 2-char suffix comes off only when 4+
// characters remain: at 3 it starts colliding ("speed" -> "spe"), and in a
// Jaccard metric a collision costs more than a miss.
const EN_ENDINGS: Array<[string, number]> = [["ingly", 3], ["edly", 3], ["ing", 3], ["ed", 4], ["ly", 4]];

export function stem(word: string, lang: Lang): string {
  if (word.length <= 3) return word;
  if (lang === "it") {
    // Italian inflects on the final vowel far more than on suffixes: dropping it
    // collapses casa/case/casi and gatto/gatti, which is most of what a stemmer
    // buys here. -zione/-zioni first, since the vowel rule alone would split them.
    if (word.length > 5 && (word.endsWith("zione") || word.endsWith("zioni"))) return word.slice(0, -1);
    if (word.length >= 4 && "aeio".includes(word[word.length - 1])) return word.slice(0, -1);
    return word;
  }
  // Plurals: Harman's s-stemmer, whose exception lists are what keep "process",
  // "status" and "goes" from being mangled.
  // One rule fires, in order. A word caught by a rule's exception list is DONE,
  // not passed down: without that, "goes" falls through to the plain-s rule and
  // comes out "goe", which is the whole thing the list exists to prevent.
  let w = word;
  if (w.endsWith("ies")) {
    if (!w.endsWith("eies") && !w.endsWith("aies")) w = w.slice(0, -3) + "y";
  } else if (w.endsWith("es")) {
    if (!w.endsWith("aes") && !w.endsWith("ees") && !w.endsWith("oes")) w = w.slice(0, -1);
  } else if (w.endsWith("s") && !w.endsWith("us") && !w.endsWith("ss")) {
    w = w.slice(0, -1);
  }
  for (const [suffix, floor] of EN_ENDINGS) {
    if (w.endsWith(suffix) && w.length - suffix.length >= floor) return w.slice(0, -suffix.length);
  }
  return w;
}

// Frontmatter, fenced and inline code, math, URLs and image embeds all carry
// tokens that are not what the note is about — a vault of lecture notes indexed
// raw ranks `boldsymbol`, `frac` and `left` among its top concepts. Wikilinks are
// unwrapped to their words rather than dropped: the title is prose too.
// Mirrors kernel/text/text.py:clean_body with fences=True (the prose setting).
const CLEAN: Array<[RegExp, string]> = [
  [/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, " "],
  // Closed fences first, matched to their own delimiter; whatever fence is left
  // after that is unclosed and runs to the end. One combined pattern cannot do
  // both under /m, where `$` means end of LINE and the block ends immediately.
  [/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, " "],
  [/^(?:```|~~~)[\s\S]*/m, " "],
  [/`[^`\n]+`/g, " "],
  [/\$\$[\s\S]*?\$\$/g, " "],
  [/\$[^$\n]+\$/g, " "],
  [/!\[\[[^\]]*\]\]/g, " "], // an embed is someone else's words
  [/https?:\/\/\S+|www\.\S+/g, " "],
  [/\[\[([^\]]+)\]\]/g, " $1 "], // keep the wikilink's words, drop the brackets
  [/[|#^]/g, " "], // and the alias/anchor separators the line above left behind
];

export function cleanBody(text: string): string {
  let out = text.slice(0, MAX_CHARS);
  for (const [re, to] of CLEAN) out = out.replace(re, to);
  return out;
}

/** {stem: count} for one body. Stopwords and sub-MIN_TOKEN_LEN tokens are dropped
 * before stemming, same order as the Python pipeline. */
export function stemCounts(text: string, lang: Lang): Map<string, number> {
  const words = STOPWORDS[lang];
  const out = new Map<string, number>();
  for (const m of cleanBody(text).toLowerCase().matchAll(TOKEN_RE)) {
    const surface = m[0];
    if (surface.length < MIN_TOKEN_LEN || words.has(surface)) continue;
    const s = stem(surface, lang);
    out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

/** `exclude` entries to lowercased folder prefixes: "Journal" and "journal/"
 * both become "journal/", so a root note that merely starts with the word is
 * untouched. Same prefix-is-what-a-folder-IS call as lexical.ts's Scope. */
function excludedSet(files: CorpusFile[], exclude: string[]): Set<string> {
  const prefixes = exclude
    .map((p) => p.trim().toLowerCase().replace(/^\/+/, "").replace(/\/*$/, "/"))
    .filter((p) => p !== "/");
  const out = new Set<string>();
  if (prefixes.length) {
    for (const f of files) {
      const path = f.path.toLowerCase();
      if (prefixes.some((p) => path.startsWith(p))) out.add(f.path);
    }
  }
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** Rebuild the corpus, re-reading only files whose mtime moved since `prev`.
 * The language is detected once on the first build and then frozen for the life
 * of the corpus: node keys are stems, and re-detecting per note would split a
 * shared term across two stemmers (kernel/recall/cooccurrence.py makes the same
 * call, one stemmer per store). */
export async function buildCorpus(
  vault: CorpusVault,
  prev?: Corpus | null,
  exclude: string[] = [],
): Promise<Corpus> {
  const files = vault.getMarkdownFiles();
  const excluded = excludedSet(files, exclude);
  const counts = new Map<string, Map<string, number>>();
  const mtimes = new Map<string, number>();
  const titles = new Map<string, string>();

  let lang = prev?.lang;
  if (lang === undefined) {
    // Sample the first few files rather than the whole vault: the classifier
    // saturates long before that and the first build is the slow one.
    const sample = (await Promise.all(files.slice(0, 8).map((f) => readOr(vault, f)))).join("\n");
    lang = detectLang(cleanBody(sample));
  }

  const stale: CorpusFile[] = [];
  for (const file of files) {
    titles.set(file.path, file.basename);
    const cached = prev?.counts.get(file.path);
    if (cached && prev?.mtimes.get(file.path) === file.stat.mtime) {
      counts.set(file.path, cached);
      mtimes.set(file.path, file.stat.mtime);
    } else {
      stale.push(file);
    }
  }
  // Nothing moved, nothing vanished and the exclusion list means the same set of
  // files: hand back the very same object. Every derived index (top-k sets,
  // discriminating stem sets, the note panel's diff cache) is memoised on Corpus
  // identity, so returning a fresh-but-equal object would throw all of them away
  // on every note switch.
  if (!stale.length && prev && prev.counts.size === files.length && sameSet(prev.excluded, excluded)) {
    return prev;
  }

  await Promise.all(
    stale.map(async (file) => {
      counts.set(file.path, stemCounts(await readOr(vault, file), lang));
      mtimes.set(file.path, file.stat.mtime);
    }),
  );

  const postings = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let total = 0;
  for (const [path, row] of counts) {
    let len = 0;
    for (const [s, n] of row) {
      let byPath = postings.get(s);
      if (!byPath) postings.set(s, (byPath = new Map<string, number>()));
      byPath.set(path, n);
      len += n;
    }
    lengths.set(path, len);
    total += len;
  }
  return { counts, mtimes, postings, lengths, avgLen: counts.size ? total / counts.size : 0, titles, excluded, lang };
}

async function readOr(vault: CorpusVault, file: CorpusFile): Promise<string> {
  try {
    return await vault.cachedRead(file);
  } catch {
    return ""; // an unreadable file indexes as empty, never aborts the build
  }
}
