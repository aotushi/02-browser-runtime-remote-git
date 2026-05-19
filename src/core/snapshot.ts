import type {
  Evidence,
  ProbeContext,
  ProbePlugin,
  ProbeType,
  RiskLevel,
  SnapshotRecord,
  SnapshotStatus,
} from "./types.js";

export function createSnapshotRecord<TValue>(input: {
  context: ProbeContext;
  probe: Pick<ProbePlugin, "id" | "layer" | "item">;
  probeType: ProbeType;
  source: string;
  status: SnapshotStatus;
  value: TValue;
  riskLevel?: RiskLevel;
  riskSummary: string;
  evidence?: Evidence[];
  durationMs?: number;
  error?: string;
}): SnapshotRecord<TValue> {
  return {
    target: input.context.input,
    normalized_target: input.context.normalizedTarget,
    snapshot_at: input.context.snapshotAt,
    probe: input.probe.id,
    layer: input.probe.layer,
    item: input.probe.item,
    probe_type: input.probeType,
    source: input.source,
    status: input.status,
    value: input.value,
    risk: {
      level: input.riskLevel ?? "info",
      summary: input.riskSummary,
    },
    evidence: input.evidence ?? [],
    browser: {
      provider: input.context.providerName,
      headed: input.context.browserOptions.headed,
      wait_ms: input.context.browserOptions.waitMs,
      timeout_ms: input.context.browserOptions.timeoutMs,
    },
    duration_ms: input.durationMs,
    error: input.error,
  };
}
