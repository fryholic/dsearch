import type { Locator } from '@dsearch/contracts';
export type Selection = {
  key: string; doc_id: string; revision_id: string; title: string; relative_path: string; collection_id: string;
  locator: ReturnType<typeof Locator.parse>; heading: string[]; excerpt: string;
};
