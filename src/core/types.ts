export type ProbeCapability = "browser_runtime" | "html_parse" | "screenshot" | "resource_observe";

export type ProbeType = "passive" | "active_request" | "third_party" | "manual";

export type SnapshotStatus = "ok" | "warning" | "error" | "skipped";

export type RiskLevel = "info" | "low" | "medium" | "high";

export type Evidence = {
  type: string;
  name?: string;
  value: unknown;
};

export type SnapshotRisk = {
  level: RiskLevel;
  summary: string;
};

export type BrowserOptions = {
  headed: boolean;
  waitMs: number;
  timeoutMs: number;
  screenshot: boolean;
  screenshotsDir: string;
};

export type SnapshotRecord<TValue = unknown> = {
  target: string;
  normalized_target: string;
  snapshot_at: string;
  probe: string;
  layer: number;
  item: string;
  probe_type: ProbeType;
  source: string;
  status: SnapshotStatus;
  value: TValue;
  risk: SnapshotRisk;
  evidence: Evidence[];
  browser: {
    provider: string;
    headed: boolean;
    wait_ms: number;
    timeout_ms: number;
  };
  duration_ms?: number;
  error?: string;
};

export type NormalizedTarget = {
  input: string;
  url: URL;
  origin: string;
  normalizedTarget: string;
};

export type ProbeContext = {
  input: string;
  targetUrl: URL;
  origin: string;
  normalizedTarget: string;
  snapshotAt: string;
  availableCapabilities: Set<ProbeCapability>;
  providerName: string;
  browserOptions: BrowserOptions;
};

export type ProbePlugin = {
  id: string;
  name: string;
  layer: number;
  item: string;
  requiredCapabilities: ProbeCapability[];
  run(context: ProbeContext): Promise<SnapshotRecord[]>;
};

export type ProbeRunResult = {
  target: NormalizedTarget;
  records: SnapshotRecord[];
};

export type ResourceSummary = {
  document: number;
  script: number;
  stylesheet: number;
  image: number;
  font: number;
  xhr: number;
  fetch: number;
  other: number;
};

export type BrowserPageSnapshot = {
  final_url: string;
  status_code: number | null;
  title: string;
  html_bytes: number;
  visible_text_bytes: number;
  resource_counts: ResourceSummary;
  resources: Array<{
    url: string;
    method: string;
    resource_type: string;
    status_code: number | null;
    failure: string | null;
  }>;
  screenshot_path: string | null;
  access_barrier: {
    detected: boolean;
    types: string[];
    title: string;
    visible_text_sample: string;
  };
};
