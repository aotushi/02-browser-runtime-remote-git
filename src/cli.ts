#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTarget, targetSlug } from "./core/normalize-target.js";
import { createSnapshotRecord } from "./core/snapshot.js";
import type { BrowserOptions, ProbeCapability, ProbeContext, ProbePlugin, ProbeRunResult } from "./core/types.js";
import { browserPageProbe } from "./probes/browser-page.js";
import { renderMarkdownReport } from "./reporters/markdown.js";

const probes = [browserPageProbe];
const capabilities: ProbeCapability[] = ["browser_runtime", "html_parse", "screenshot", "resource_observe"];

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.target || options.target === "-h" || options.target === "--help") {
    printHelp();
    process.exit(options.target ? 0 : 1);
  }

  const result = await runBrowserProbeEngine(options.target, options.browserOptions);
  const stamp = result.records[0]?.snapshot_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const slug = targetSlug(result.target.normalizedTarget);
  const outputBaseName = `${slug}-browser-${stamp}`;
  const snapshotsDir = path.resolve("snapshots");
  const reportsDir = path.resolve("reports");
  const snapshotPath = path.join(snapshotsDir, `${outputBaseName}.json`);
  const reportPath = path.join(reportsDir, `${outputBaseName}.md`);

  await mkdir(snapshotsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(result.records, null, 2)}\n`, "utf-8");
  await writeFile(reportPath, renderMarkdownReport(result), "utf-8");

  console.log(`Target: ${result.target.url.toString()}`);
  console.log("Provider: playwright-local");
  console.log(`Records: ${result.records.length}`);
  console.log(`Snapshot: ${snapshotPath}`);
  console.log(`Report: ${reportPath}`);
}

async function runBrowserProbeEngine(targetInput: string, browserOptions: BrowserOptions): Promise<ProbeRunResult> {
  const target = normalizeTarget(targetInput);
  const snapshotAt = new Date().toISOString();
  const availableCapabilities = new Set(capabilities);
  const context: ProbeContext = {
    input: target.input,
    targetUrl: target.url,
    origin: target.origin,
    normalizedTarget: target.normalizedTarget,
    snapshotAt,
    availableCapabilities,
    providerName: "playwright-local",
    browserOptions,
  };

  const records = [];

  for (const probe of probes) {
    const missingCapabilities = probe.requiredCapabilities.filter((capability) => !availableCapabilities.has(capability));

    if (missingCapabilities.length > 0) {
      records.push(createSkippedRecord(context, probe, missingCapabilities));
      continue;
    }

    try {
      records.push(...(await probe.run(context)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      records.push(
        createSnapshotRecord({
          context,
          probe,
          probeType: "active_request",
          source: "probe_engine",
          status: "error",
          value: null,
          riskLevel: "medium",
          riskSummary: `Probe failed: ${message}`,
          error: message,
        }),
      );
    }
  }

  return { target, records };
}

function createSkippedRecord(context: ProbeContext, probe: ProbePlugin, missingCapabilities: ProbeCapability[]) {
  return createSnapshotRecord({
    context,
    probe,
    probeType: "manual",
    source: "probe_engine",
    status: "skipped",
    value: { missing_capabilities: missingCapabilities },
    riskLevel: "info",
    riskSummary: `Skipped because required capabilities are missing: ${missingCapabilities.join(", ")}`,
  });
}

function parseArgs(args: string[]): { target?: string; browserOptions: BrowserOptions } {
  let target: string | undefined;
  const browserOptions: BrowserOptions = {
    headed: false,
    waitMs: 1000,
    timeoutMs: 30000,
    screenshot: true,
    screenshotsDir: path.resolve("screenshots"),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--headed") {
      browserOptions.headed = true;
      continue;
    }

    if (arg === "--no-screenshot") {
      browserOptions.screenshot = false;
      continue;
    }

    if (arg === "--wait-ms") {
      browserOptions.waitMs = parseNonNegativeIntegerOption(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--wait-ms=")) {
      browserOptions.waitMs = parseNonNegativeIntegerOption("--wait-ms", arg.slice("--wait-ms=".length));
      continue;
    }

    if (arg === "--timeout-ms") {
      browserOptions.timeoutMs = parsePositiveIntegerOption(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      browserOptions.timeoutMs = parsePositiveIntegerOption("--timeout-ms", arg.slice("--timeout-ms=".length));
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      target = arg;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (target) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    target = arg;
  }

  return { target, browserOptions };
}

function parseNonNegativeIntegerOption(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} requires a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveIntegerOption(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer.`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  site-check-browser [options] <url-or-domain>

Examples:
  site-check-browser https://example.com
  site-check-browser --wait-ms 5000 https://www.cloudflare.com/learning/dns/dns-records/dns-a-record/
  site-check-browser --headed https://example.com

Options:
  --headed              Show the browser window
  --wait-ms <ms>        Extra wait after network idle, default 1000
  --timeout-ms <ms>     Page navigation timeout, default 30000
  --no-screenshot       Do not save a screenshot
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
