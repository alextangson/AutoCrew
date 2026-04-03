import type { IntelItem } from "../../storage/pipeline-store.js";

export interface CollectorResult {
  items: IntelItem[];
  source: string;
  errors: string[];
}

export interface Collector {
  id: string;
  collect(opts: CollectorOptions): Promise<CollectorResult>;
}

export interface CollectorOptions {
  keywords: string[];
  industry: string;
  platforms: string[];
  dataDir?: string;
}
