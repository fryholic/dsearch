import type { ModelInfo, ProfileCatalog } from '@dsearch/contracts/control';
/** Presence is enough to request verification; a known missing/bad file requires explicit recovery or fallback. */
export function unavailableModel(mode: string, rerank: boolean, allowDegraded: boolean, models: ModelInfo[], catalog: ProfileCatalog): string | null {
  if (mode === 'lexical' || mode === 'literal' || allowDegraded) return null;
  const profile = catalog.profiles.find(p => p.profile_id === catalog.selected_profile_id), embedRole = profile?.manifest.models.embed.dimension === 768 ? 'reference' : 'embed';
  for (const role of [embedRole, ...(rerank ? ['rerank'] : [])]) {
    const model = models.find(m => m.role === role);
    if (!model || ['missing', 'invalid'].includes(model.state)) return role === 'rerank' ? '리랭킹 모델을 준비하거나 리랭킹을 꺼 주세요. 대체 검색은 직접 허용할 수 있어요.' : '임베딩 모델을 준비하거나 키워드 검색을 사용하세요. 대체 검색은 직접 허용할 수 있어요.';
  }
  return null;
}
