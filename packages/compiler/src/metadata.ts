export type MetadataScalar = string | number | boolean;
export type SearchMetadata = Record<string, MetadataScalar | MetadataScalar[]>;

/** Preserve raw frontmatter separately; derive bounded, typed fields for search. */
export function normalizeMetadata(metadata: Record<string, unknown>): { values: SearchMetadata; warnings: string[] } {
  const values: SearchMetadata = Object.create(null), warnings: string[] = [];
  const put = (key: string, value: unknown, depth: number): void => {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || key === 'document_key') { warnings.push(key);return; }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (depth >= 6) { warnings.push(key);return; }
      for (const part of Object.keys(value).sort()) put(key + '.' + part, (value as Record<string, unknown>)[part], depth + 1);
      return;
    }
    if (Object.keys(values).length >= 63) { warnings.push(key);return; }
    const scalar = (v: unknown): v is MetadataScalar => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 1024);
    if (scalar(value)) { values[key] = value;return; }
    if (Array.isArray(value) && value.length && value.length <= 128 && value.every(scalar) && value.every(v => typeof v === typeof value[0])) { values[key] = [...value];return; }
    if (value !== null && !(Array.isArray(value) && !value.length)) warnings.push(key);
  };
  const keys = [...new Set(['role', 'type', 'status', 'topics', ...Object.keys(metadata).sort()])];
  for (const key of keys) if (Object.hasOwn(metadata, key)) put(key, metadata[key], 0);
  return { values, warnings: [...new Set(warnings)].slice(0, 64) };
}
