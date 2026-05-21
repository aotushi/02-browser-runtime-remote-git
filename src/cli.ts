#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTarget, targetSlug } from "./core/normalize-target.js";
import { createSnapshotRecord } from "./core/snapshot.js";
import type { BrowserOptions, ProbeCapability, ProbeContext, ProbePlugin, ProbeRunResult } from "./core/types.js";
import { browserPageProbe } from "./probes/browser-page.js";
import { renderMarkdownReport } from "./reporters/markdown.js";

type BrowserRuntimeProviderId = "playwright-local" | "github-actions-browser";

type CliOptions = {
  target?: string;
  targetFile?: string;
  providerName: BrowserRuntimeProviderId;
  help: boolean;
  browserOptions: BrowserOptions;
};

type TargetRun = {
  target: string;
  providerName: BrowserRuntimeProviderId;
  browserOptions: BrowserOptions;
};

type TargetFileEntry =
  | string
  | {
      url?: unknown;
      target?: unknown;
      wait_ms?: unknown;
      waitMs?: unknown;
      timeout_ms?: unknown;
      timeoutMs?: unknown;
      screenshot?: unknown;
      headed?: unknown;
      provider?: unknown;
    };

const probes = [browserPageProbe];
const capabilities: ProbeCapability[] = ["browser_runtime", "html_parse", "screenshot", "resource_observe"];

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const targetRuns = await resolveTargetRuns(options);

  if (targetRuns.length === 0) {
    printHelp();
    process.exit(1);
  }

  const snapshotsDir = path.resolve("snapshots");
  const reportsDir = path.resolve("reports");
  await mkdir(snapshotsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  console.log(`Targets: ${targetRuns.length}`);
  console.log(`Provider: ${options.providerName}`);

  for (const targetRun of targetRuns) {
    const result = await runBrowserProbeEngine(targetRun.target, targetRun.providerName, targetRun.browserOptions);
    const output = await writeRunOutputs(result, snapshotsDir, reportsDir);

    console.log("");
    console.log(`Target: ${result.target.url.toString()}`);
    console.log(`Records: ${result.records.length}`);
    console.log(`Snapshot: ${output.snapshotPath}`);
    console.log(`Report: ${output.reportPath}`);
  }
}

async function writeRunOutputs(result: ProbeRunResult, snapshotsDir: string, reportsDir: string) {
  const stamp = result.records[0]?.snapshot_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const slug = targetSlug(result.target.normalizedTarget);
  const outputBaseName = `${slug}-browser-${stamp}`;
  const snapshotPath = path.join(snapshotsDir, `${outputBaseName}.json`);
  const reportPath = path.join(reportsDir, `${outputBaseName}.md`);

  await writeFile(snapshotPath, `${JSON.stringify(result.records, null, 2)}\n`, "utf-8");
  await writeFile(reportPath, renderMarkdownReport(result), "utf-8");

  return { snapshotPath, reportPath };
}

async function resolveTargetRuns(options: CliOptions): Promise<TargetRun[]> {
  if (options.target && options.targetFile) {
    throw new Error("Use either a positional target or --target-file, not both.");
  }

  if (options.targetFile) {
    return readTargetFile(options.targetFile, options.providerName, options.browserOptions);
  }

  if (options.target) {
    return [
      {
        target: options.target,
        providerName: options.providerName,
        browserOptions: cloneBrowserOptions(options.browserOptions),
      },
    ];
  }

  return [];
}

async function readTargetFile(
  targetFile: string,
  defaultProviderName: BrowserRuntimeProviderId,
  defaultOptions: BrowserOptions,
): Promise<TargetRun[]> {
  const filePath = path.resolve(targetFile);
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.targets)
      ? parsed.targets
      : null;

  if (!entries) {
    throw new Error("--target-file must contain a JSON array or an object with a targets array.");
  }

  return entries.map((entry, index) => parseTargetFileEntry(entry as TargetFileEntry, index, defaultProviderName, defaultOptions));
}

function parseTargetFileEntry(
  entry: TargetFileEntry,
  index: number,
  defaultProviderName: BrowserRuntimeProviderId,
  defaultOptions: BrowserOptions,
): TargetRun {
  if (typeof entry === "string") {
    return {
      target: entry,
      providerName: defaultProviderName,
      browserOptions: cloneBrowserOptions(defaultOptions),
    };
  }

  if (!isRecord(entry)) {
    throw new Error(`Target entry at index ${index} must be a string or object.`);
  }

  const target = typeof entry.url === "string" ? entry.url : typeof entry.target === "string" ? entry.target : null;

  if (!target) {
    throw new Error(`Target entry at index ${index} requires a string url or target field.`);
  }

  const browserOptions = cloneBrowserOptions(defaultOptions);
  const providerName =
    entry.provider === undefined
      ? defaultProviderName
      : parseProviderOption(`targets[${index}].provider`, String(entry.provider));
  const waitMs = entry.wait_ms ?? entry.waitMs;
  const timeoutMs = entry.timeout_ms ?? entry.timeoutMs;

  if (waitMs !== undefined) {
    browserOptions.waitMs = parseNonNegativeIntegerOption(`targets[${index}].wait_ms`, String(waitMs));
  }

  if (timeoutMs !== undefined) {
    browserOptions.timeoutMs = parsePositiveIntegerOption(`targets[${index}].timeout_ms`, String(timeoutMs));
  }

  if (entry.screenshot !== undefined) {
    if (typeof entry.screenshot !== "boolean") {
      throw new Error(`targets[${index}].screenshot must be a boolean.`);
    }
    browserOptions.screenshot = entry.screenshot;
  }

  if (entry.headed !== undefined) {
    if (typeof entry.headed !== "boolean") {
      throw new Error(`targets[${index}].headed must be a boolean.`);
    }
    browserOptions.headed = entry.headed;
  }

  return { target, providerName, browserOptions };
}

async function runBrowserProbeEngine(
  targetInput: string,
  providerName: BrowserRuntimeProviderId,
  browserOptions: BrowserOptions,
): Promise<ProbeRunResult> {
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
    providerName,
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

function parseArgs(args: string[]): CliOptions {
  let target: string | undefined;
  let targetFile: string | undefined;
  let providerName: BrowserRuntimeProviderId = "playwright-local";
  let help = false;
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

    if (arg === "--target-file") {
      targetFile = parseRequiredStringOption(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--target-file=")) {
      targetFile = parseRequiredStringOption("--target-file", arg.slice("--target-file=".length));
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

    if (arg === "--provider") {
      providerName = parseProviderOption(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      providerName = parseProviderOption("--provider", arg.slice("--provider=".length));
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      help = true;
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

  return { target, targetFile, providerName, help, browserOptions };
}

function parseRequiredStringOption(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
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

function parseProviderOption(name: string, value: string | undefined): BrowserRuntimeProviderId {
  if (value === "playwright-local" || value === "github-actions-browser") {
    return value;
  }
  throw new Error(`${name} must be one of: playwright-local, github-actions-browser.`);
}

function cloneBrowserOptions(options: BrowserOptions): BrowserOptions {
  return { ...options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp() {
  console.log(`Usage:
  site-check-browser [options] <url-or-domain>
  site-check-browser [options] --target-file <path>

Examples:
  site-check-browser https://example.com
  site-check-browser --target-file targets.json
  site-check-browser --wait-ms 5000 https://www.cloudflare.com/learning/dns/dns-records/dns-a-record/
  site-check-browser --headed https://example.com

Options:
  --target-file <path>  Read targets from a JSON file
  --provider <id>       Runtime provider metadata: playwright-local or github-actions-browser
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
