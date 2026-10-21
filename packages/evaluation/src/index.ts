export type Grade = 0 | 1 | 2;
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
