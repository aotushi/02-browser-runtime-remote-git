import { playwrightLocalProvider } from "../browser/playwright-local.js";
import { createSnapshotRecord } from "../core/snapshot.js";
import type { Evidence, ProbeContext, ProbePlugin, RiskLevel, SnapshotStatus } from "../core/types.js";

export const browserPageProbe: ProbePlugin = {
  id: "browser_page_probe",
  name: "Browser Page Probe",
  layer: 4,
  item: "browser_page",
  requiredCapabilities: ["browser_runtime", "html_parse", "resource_observe"],
  async run(context: ProbeContext) {
    const startedAt = performance.now();
    const snapshot = await playwrightLocalProvider.snapshotPage({
      target: {
        input: context.input,
        url: context.targetUrl,
        origin: context.origin,
        normalizedTarget: context.normalizedTarget,
      },
      snapshotAt: context.snapshotAt,
      options: context.browserOptions,
    });
    const barrierDetected = snapshot.access_barrier.detected;
    const status: SnapshotStatus = barrierDetected ? "warning" : "ok";
    const riskLevel: RiskLevel = barrierDetected ? "medium" : "info";
    const evidence: Evidence[] = [
      { type: "final_url", value: snapshot.final_url },
      { type: "status_code", value: snapshot.status_code },
      { type: "html_title", value: snapshot.title },
    ];

    if (snapshot.screenshot_path) {
      evidence.push({ type: "screenshot", value: snapshot.screenshot_path });
    }

    if (barrierDetected) {
      evidence.push({ type: "barrier_type", value: snapshot.access_barrier.types });
    }

    return [
      createSnapshotRecord({
        context,
        probe: browserPageProbe,
        probeType: "active_request",
        source: context.providerName,
        status,
        value: snapshot,
        riskLevel,
        riskSummary: barrierDetected
          ? `Browser runtime still detected an access barrier: ${snapshot.access_barrier.types.join(", ")}.`
          : "Browser runtime loaded the page without common access barrier signals.",
        evidence,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    ];
  },
};
