export type Grade = 0 | 1 | 2;
export type CandidateObservation = {
  stage: 'bm25' | 'rrf_before_chunk_selection';
  budget: number;
  candidates: { document_id: string; passage_id: string; rank: number }[];
};
export type RelevanceReference = {
  kind: 'pooled' | 'exhaustive';
  complete: boolean;
  answerability: 'answerable' | 'no_answer' | 'unknown';
  grades: Record<string, Grade>;
};

/** Separate the actual retrieval pool from the product's final, grouped ranking. */
export function scoreRetrieval(pool: CandidateObservation, finalRanking: string[], reference: RelevanceReference) {
  const validId = (id: string) => typeof id === 'string' && id.length > 0;
  if (!['bm25', 'rrf_before_chunk_selection'].includes(pool.stage) || !Number.isSafeInteger(pool.budget) || pool.budget < 1 || pool.budget > 80 || pool.candidates.length > pool.budget ||
    pool.candidates.some((c, index) => !validId(c.document_id) || !validId(c.passage_id) || c.rank !== index + 1) ||
    new Set(pool.candidates.map(c => c.passage_id)).size !== pool.candidates.length)
    throw new Error('Invalid candidate observation');
  const documents = [...new Set(pool.candidates.map(c => c.document_id))], retrieved = new Set(documents);
  if (finalRanking.some(id => !validId(id) || !retrieved.has(id)) || new Set(finalRanking).size !== finalRanking.length)
    throw new Error('Final ranking is not a unique subset of the observed pool');
  if (!['pooled', 'exhaustive'].includes(reference.kind) || typeof reference.complete !== 'boolean' || !['answerable', 'no_answer', 'unknown'].includes(reference.answerability) ||
    Object.entries(reference.grades).some(([id, grade]) => !validId(id) || ![0, 1, 2].includes(grade)))
    throw new Error('Invalid relevance reference');
  const entries = Object.entries(reference.grades), relevant = entries.filter(([, grade]) => grade > 0).map(([id]) => id), direct = entries.filter(([, grade]) => grade === 2).map(([id]) => id);
  if (reference.answerability === 'no_answer' && relevant.length || reference.complete && reference.answerability === 'answerable' && !relevant.length)
    throw new Error('Conflicting answerability judgments');
  const unjudgedCandidates = documents.filter(id => !Object.hasOwn(reference.grades, id));
  const unjudgedRanking = finalRanking.slice(0, 10).filter(id => !Object.hasOwn(reference.grades, id));
  const provisional = !reference.complete || reference.answerability === 'unknown' || unjudgedCandidates.length > 0 || unjudgedRanking.length > 0;
  const recall = (ids: string[]) => provisional || !ids.length ? null : ids.filter(id => retrieved.has(id)).length / ids.length;
  const gain = (grade: number, index: number) => (2 ** grade - 1) / Math.log2(index + 2);
  const ideal = entries.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, 10).reduce<number>((sum, grade, index) => sum + gain(grade, index), 0);
  const dcg = finalRanking.slice(0, 10).reduce((sum, id, index) => sum + gain(reference.grades[id] ?? 0, index), 0);
  const firstDirect = finalRanking.slice(0, 10).findIndex(id => reference.grades[id] === 2);
  return {
    provisional, referenceKind: reference.kind, answerability: reference.answerability,
    candidateStage: pool.stage, candidateBudget: pool.budget, budgetUnit: 'passages' as const,
    observedCandidatePassages: pool.candidates.length, observedCandidateDocuments: documents.length,
    judgedReferenceDocuments: entries.length, judgedRelevantDocuments: relevant.length,
    unjudgedCandidates, unjudgedRanking,
    // The LLD defines the release Recall target using grade-2 direct support.
    recallRelevanceThreshold: 2 as const,
    candidateRecall: recall(direct), anyRelevantCandidateRecall: recall(relevant),
    ndcg10: provisional || !ideal ? null : dcg / ideal,
    directMrr10: provisional || !direct.length ? null : firstDirect < 0 ? 0 : 1 / (firstDirect + 1),
    noAnswerReturnedDocuments: reference.answerability === 'no_answer' ? finalRanking.length : null,
  };
}

/** Legacy single-list diagnostics; release evaluation uses scoreRetrieval with an actual pool. */
export function scoreRanking(ranking: string[], relevance: Record<string, Grade>) {
  const unique = [...new Set(ranking)];
  const unjudged = unique.slice(0, 10).filter(id => relevance[id] === undefined);
  const knownDirect = Object.keys(relevance).filter(id => relevance[id] === 2);
  const gain = (grade: number, index: number) => (2 ** grade - 1) / Math.log2(index + 2);
  const dcg = unique.slice(0, 10).reduce((sum, id, i) => sum + gain(relevance[id] ?? 0, i), 0);
  const ideal = Object.values(relevance).sort((a, b) => b - a).slice(0, 10).reduce<number>((sum, grade, i) => sum + gain(grade, i), 0);
  const first = unique.slice(0, 10).findIndex(id => relevance[id] === 2);
  return { provisional: unjudged.length > 0, unjudged,
    recall40: knownDirect.length ? unique.slice(0, 40).filter(id => relevance[id] === 2).length / knownDirect.length : null,
    ndcg10: ideal && !unjudged.length ? dcg / ideal : null,
    mrr10: !unjudged.length ? first < 0 ? 0 : 1 / (first + 1) : null,
    top1Direct: relevance[unique[0] ?? ""] === 2, uniqueCandidates: unique.length };
}
export function percentile(values: number[], percentileValue: number): number {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0) || percentileValue <= 0 || percentileValue > 1)
    throw new Error("Invalid measurements");
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)]!;
}
export type EvaluationCase = { id: string; groups: string[]; split: "tuning" | "holdout" };
export function validateEvaluationSplit(cases: EvaluationCase[], requireFull = true) {
  const ids = new Set<string>(), groups = new Map<string, string>();
  for (const item of cases) {
    if (!item.id || ids.has(item.id) || !item.groups.length) throw new Error("Invalid evaluation identity");
    ids.add(item.id);
    for (const group of item.groups) {
      if (groups.has(group) && groups.get(group) !== item.split) throw new Error("Evaluation group leakage");
      groups.set(group, item.split);
    }
  }
  const tuning = cases.filter(item => item.split === "tuning").length;
  const holdout = cases.filter(item => item.split === "holdout").length;
  if (requireFull && (tuning < 20 || holdout < 40)) throw new Error("Incomplete fixed evaluation");
  return { tuning, holdout, sourceGroups: groups.size };
}
