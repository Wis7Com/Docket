import { citationLexicalSupport } from "./citationRepair";

/**
 * Deterministic re-binding of a citation the support gate could not confirm.
 *
 * A local mapper model frequently names the wrong passage handle for a claim —
 * in a claim/response table it typically attaches the passage that supports the
 * NEIGHBORING row. The correct passage is almost always in the same turn-scoped
 * registry (the model saw it), so the server can re-point the citation without
 * another model call. This module is pure: the caller supplies the claim text,
 * the candidate passages, and any semantic prior.
 */

export type RebindCandidate = Readonly<{
  /** Single-sentence handle id minted by the turn registry, e.g. "p12". */
  passage: string;
  chunkId: string;
  docId: string;
  text: string;
}>;

export type RebindResult = Readonly<{
  passage: string;
  score: number;
  sharedWords: number;
  nearVerbatim: boolean;
}>;

type LexicalSupport = ReturnType<typeof citationLexicalSupport>;

type ScoredCandidate = Readonly<{
  candidate: RebindCandidate;
  /** Input position, kept so equal scores resolve deterministically. */
  order: number;
  support: LexicalSupport;
}>;

/**
 * The gate below mirrors the one applied to model-authored citations. A
 * rebound citation has to be verified by construction: re-pointing a marker at
 * a passage that would itself render as an amber "?" trades one wrong citation
 * for another.
 */
const REBIND_MIN_SHARED_WORDS = 2;
const REBIND_MIN_SCORE = 0.3;

/**
 * Two passages in the same chunk often paraphrase each other, so a hair-thin
 * lead is noise rather than evidence. Ambiguity must abstain, not guess.
 */
const REBIND_MIN_MARGIN = 0.05;

const REBIND_DEFAULT_SEMANTIC_TOP_K = 3;

function qualifies(support: LexicalSupport): boolean {
  return (
    support.nearVerbatim ||
    (support.sharedWords >= REBIND_MIN_SHARED_WORDS &&
      support.score >= REBIND_MIN_SCORE)
  );
}

function scoreCandidates(
  claimContext: string,
  candidates: readonly RebindCandidate[],
): ScoredCandidate[] {
  return candidates.map((candidate, order) => ({
    candidate,
    order,
    support: citationLexicalSupport(claimContext, candidate.text),
  }));
}

/** Highest support first; equal support keeps the earlier input position. */
function rankQualifiers(scored: readonly ScoredCandidate[]): ScoredCandidate[] {
  return scored
    .filter((entry) => qualifies(entry.support))
    .sort((a, b) => b.support.score - a.support.score || a.order - b.order);
}

/**
 * A verbatim sentence match is categorically stronger than a bag-of-words
 * overlap, so it wins even against an equally scored runner-up — the numeric
 * margin only adjudicates comparisons of the same kind.
 */
function clearsMargin(
  winner: ScoredCandidate,
  runnerUp: ScoredCandidate | undefined,
): boolean {
  if (runnerUp === undefined) return true;
  if (winner.support.nearVerbatim && !runnerUp.support.nearVerbatim) {
    return true;
  }
  return winner.support.score - runnerUp.support.score >= REBIND_MIN_MARGIN;
}

/**
 * Guard against a "repair" that is no better than the passage already named.
 * Callers only reach this path for unconfirmed citations, but a rebind that
 * lowers support would still be a regression.
 */
function improvesOnCurrent(
  winner: ScoredCandidate,
  claimContext: string,
  currentPassageText: string | null,
): boolean {
  if (currentPassageText === null) return true;
  const current = citationLexicalSupport(claimContext, currentPassageText);
  return winner.support.score > current.score;
}

/**
 * Lexical overlap alone can favour a boilerplate sentence from an unrelated
 * chunk. When the caller supplies embedding similarities, confine the winner to
 * the chunks that were semantically close to the claim; an unranked chunk is
 * treated as out of range rather than unconstrained.
 */
function withinSemanticTopK(
  chunkId: string,
  semanticScoreByChunk: ReadonlyMap<string, number> | undefined,
  topK: number,
): boolean {
  if (semanticScoreByChunk === undefined) return true;
  if (topK <= 0) return false;
  return [...semanticScoreByChunk.entries()]
    .map(([id, score], order) => ({ id, score, order }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, topK)
    .some((entry) => entry.id === chunkId);
}

export function rebindUnconfirmedCitation(input: {
  /** Cell-scoped claim text preceding the marker. */
  claimContext: string;
  /** Text of the passage currently (wrongly) named; null when unknown. */
  currentPassageText: string | null;
  candidates: readonly RebindCandidate[];
  /** chunkId -> similarity of that chunk to the claim (higher = closer). */
  semanticScoreByChunk?: ReadonlyMap<string, number>;
  semanticTopK?: number;
}): RebindResult | null {
  const ranked = rankQualifiers(
    scoreCandidates(input.claimContext, input.candidates),
  );
  const winner = ranked[0];
  if (winner === undefined) return null;
  if (!clearsMargin(winner, ranked[1])) return null;
  if (
    !improvesOnCurrent(winner, input.claimContext, input.currentPassageText)
  ) {
    return null;
  }
  if (
    !withinSemanticTopK(
      winner.candidate.chunkId,
      input.semanticScoreByChunk,
      input.semanticTopK ?? REBIND_DEFAULT_SEMANTIC_TOP_K,
    )
  ) {
    return null;
  }
  return Object.freeze({
    passage: winner.candidate.passage,
    score: winner.support.score,
    sharedWords: winner.support.sharedWords,
    nearVerbatim: winner.support.nearVerbatim,
  });
}

/**
 * Cross-language support detection.
 *
 * The lexical gate compares content words, so a Korean claim citing an
 * English passage scores zero no matter how correct the citation is — a
 * whole answer written in Korean loses every verified badge at once. When
 * the claim and the quote are written in different scripts, word overlap is
 * structurally meaningless and an embedding similarity is the only usable
 * signal. The check is deliberately restricted to that case: for
 * same-script pairs the lexical gate stays authoritative, because a
 * same-topic-but-wrong citation can sit near the semantic threshold while
 * cross-script correct pairs calibrate well above mismatched ones
 * (measured on production data: correct 0.60-0.75, mismatched ≤ 0.42).
 */
export const CROSS_LANGUAGE_SUPPORT_THRESHOLD = 0.55;

const HANGUL_OR_CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/u;
const LATIN = /[a-z]/i;

function scriptProfile(text: string): { cjk: number; latin: number } {
  let cjk = 0;
  let latin = 0;
  for (const char of text) {
    if (HANGUL_OR_CJK.test(char)) cjk += 1;
    else if (LATIN.test(char)) latin += 1;
  }
  return { cjk, latin };
}

export function isCrossScriptClaim(claimText: string, quote: string): boolean {
  const claim = scriptProfile(claimText);
  const source = scriptProfile(quote);
  const claimLetters = claim.cjk + claim.latin;
  const sourceLetters = source.cjk + source.latin;
  if (claimLetters === 0 || sourceLetters === 0) return false;
  const claimCjkShare = claim.cjk / claimLetters;
  const sourceCjkShare = source.cjk / sourceLetters;
  return (
    (claimCjkShare >= 0.2 && sourceCjkShare < 0.05) ||
    (sourceCjkShare >= 0.2 && claimCjkShare < 0.05)
  );
}

export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
