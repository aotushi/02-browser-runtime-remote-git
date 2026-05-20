#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { chromium } from "playwright";

const args = parseArgs(process.argv.slice(2));

if (!args.target) {
  console.error("Usage: npm run probe:lighthouse -- https://example.com [--strategy mobile|desktop] [--out snapshots/example.com-lighthouse.json]");
  process.exit(1);
}

const startedAt = Date.now();
const snapshotAt = new Date().toISOString();
const target = normalizeUrl(args.target);
const targetUrl = new URL(target);
const normalizedTarget = targetUrl.hostname.toLowerCase();
const date = snapshotAt.slice(0, 10);
const strategy = args.strategy || "mobile";
const outputPath = args.out || `snapshots/${normalizedTarget}-lighthouse-${strategy}-${date}.json`;
const reportPath = args.report || `reports/${normalizedTarget}-lighthouse-${strategy}-${date}.md`;

let chrome;

try {
  chrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  const runnerResult = await lighthouse(target, buildLighthouseOptions(strategy, chrome.port));
  if (!runnerResult?.lhr) throw new Error("Lighthouse did not return an LHR result.");

  const record = createRecord({
    target,
    normalizedTarget,
    snapshotAt,
    durationMs: Date.now() - startedAt,
    strategy,
    lhr: runnerResult.lhr,
  });
  const artifact = {
    records: [record],
    lighthouse_summary: {
      requested_url: target,
      final_url: runnerResult.lhr.finalDisplayedUrl ?? runnerResult.lhr.finalUrl ?? null,
      strategy,
      fetch_time: runnerResult.lhr.fetchTime,
      lighthouse_version: runnerResult.lhr.lighthouseVersion,
      user_agent: runnerResult.lhr.userAgent,
      environment: runnerResult.lhr.environment,
      categories: Object.fromEntries(
        Object.entries(runnerResult.lhr.categories ?? {}).map(([id, category]) => [id, category.score ?? null]),
      ),
    },
  };

  await writeJson(outputPath, artifact);
  await writeText(reportPath, renderMarkdown(record));

  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${reportPath}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const record = createErrorRecord({
    target,
    normalizedTarget,
    snapshotAt,
    durationMs: Date.now() - startedAt,
    strategy,
    error: message,
  });
  const artifact = { records: [record] };

  await writeJson(outputPath, artifact);
  await writeText(reportPath, renderMarkdown(record));

  console.error(message);
  process.exitCode = 2;
} finally {
  if (chrome) await chrome.kill();
}

function parseArgs(values) {
  const result = { target: "", out: "", report: "", strategy: "mobile" };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--out") {
      result.out = values[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--report") {
      result.report = values[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--strategy") {
      result.strategy = normalizeStrategy(values[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (!result.target) result.target = value;
  }

  return result;
}

function normalizeStrategy(value) {
  return value === "desktop" ? "desktop" : "mobile";
}

function normalizeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function buildLighthouseOptions(strategy, port) {
  return {
    port,
    output: "json",
    onlyCategories: ["performance"],
    formFactor: strategy,
    screenEmulation: strategy === "desktop"
      ? {
          mobile: false,
          width: 1350,
          height: 940,
          deviceScaleFactor: 1,
          disabled: false,
        }
      : undefined,
    throttling: strategy === "desktop" ? desktopThrottling() : undefined,
    throttlingMethod: "simulate",
  };
}

function desktopThrottling() {
  return {
    rttMs: 40,
    throughputKbps: 10 * 1024,
    cpuSlowdownMultiplier: 1,
    requestLatencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  };
}

function createRecord(input) {
  const performanceScore = input.lhr.categories?.performance?.score ?? null;
  const metrics = buildMetrics(input.lhr);
  const poorMetrics = metrics.filter((metric) => metric.rating === "poor");
  const needsImprovementMetrics = metrics.filter((metric) => metric.rating === "needs_improvement");
  const opportunities = buildOpportunities(input.lhr);
  const risk = assessRisk(performanceScore, poorMetrics.length, needsImprovementMetrics.length);

  return {
    target: input.target,
    normalized_target: input.normalizedTarget,
    snapshot_at: input.snapshotAt,
    probe: "performance_probe",
    layer: 5,
    item: "performance",
    probe_type: "lighthouse",
    source: "github_actions_lighthouse",
    status: risk.level === "medium" || risk.level === "high" ? "warning" : "ok",
    value: {
      requested_url: input.target,
      final_url: input.lhr.finalDisplayedUrl ?? input.lhr.finalUrl ?? null,
      strategy: input.strategy,
      provider: "lighthouse",
      performance_score: performanceScore,
      metrics,
      opportunities,
      raw_summary: {
        performance_score: performanceScore,
        lighthouse_version: input.lhr.lighthouseVersion,
        fetch_time: input.lhr.fetchTime,
        environment: input.lhr.environment,
      },
    },
    risk,
    evidence: [
      { type: "performance_metrics", name: "lighthouse", value: metrics },
      { type: "performance_opportunities", name: "lighthouse", value: opportunities },
    ],
    evidence_metadata: {
      origin: "external_provider",
      role: "derived",
      method: "external_api",
      limitations: [
        "Collected by Lighthouse in a GitHub Actions runner using a bundled Chromium browser.",
        "This is lab data from the runner network and device profile, not field Core Web Vitals.",
        "Scores vary by run timing, target location, throttling profile, and third-party resources.",
      ],
    },
    browser: {
      provider: "github_actions_playwright_chromium",
      headed: false,
      wait_ms: 0,
      timeout_ms: 45_000,
    },
    duration_ms: input.durationMs,
  };
}

function createErrorRecord(input) {
  return {
    target: input.target,
    normalized_target: input.normalizedTarget,
    snapshot_at: input.snapshotAt,
    probe: "performance_probe",
    layer: 5,
    item: "performance",
    probe_type: "lighthouse",
    source: "github_actions_lighthouse",
    status: "error",
    value: {
      requested_url: input.target,
      final_url: null,
      strategy: input.strategy,
      provider: "lighthouse",
      error: input.error,
    },
    risk: {
      level: "high",
      summary: `Lighthouse performance probe failed: ${input.error}`,
    },
    evidence: [{ type: "error", value: input.error }],
    evidence_metadata: {
      origin: "external_provider",
      role: "raw",
      method: "external_api",
      limitations: [
        "The Lighthouse run failed before performance metrics could be collected.",
        "A failure may be caused by browser startup, target availability, navigation timeout, or access barriers.",
      ],
    },
    duration_ms: input.durationMs,
    error: input.error,
  };
}

function buildMetrics(lhr) {
  const audits = lhr.audits ?? {};
  return [
    metricFromAudit(audits["first-contentful-paint"], "first_contentful_paint", "First Contentful Paint", "ms"),
    metricFromAudit(audits["largest-contentful-paint"], "largest_contentful_paint", "Largest Contentful Paint", "ms"),
    metricFromAudit(audits["total-blocking-time"], "total_blocking_time", "Total Blocking Time", "ms"),
    metricFromAudit(audits["cumulative-layout-shift"], "cumulative_layout_shift", "Cumulative Layout Shift", "count"),
    metricFromAudit(audits["speed-index"], "speed_index", "Speed Index", "ms"),
  ].filter(Boolean);
}

function metricFromAudit(audit, id, label, unit) {
  if (!audit) return null;
  return {
    id,
    label,
    value: typeof audit.numericValue === "number" ? audit.numericValue : null,
    unit,
    rating: ratingFromScore(audit.score),
    display_value: audit.displayValue ?? null,
  };
}

function buildOpportunities(lhr) {
  return Object.values(lhr.audits ?? {})
    .filter((audit) => audit?.details?.type === "opportunity")
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      score: typeof audit.score === "number" ? audit.score : null,
      estimated_savings_ms: typeof audit.details?.overallSavingsMs === "number" ? audit.details.overallSavingsMs : null,
      estimated_savings_bytes: typeof audit.details?.overallSavingsBytes === "number" ? audit.details.overallSavingsBytes : null,
    }))
    .sort((left, right) => (right.estimated_savings_ms ?? 0) - (left.estimated_savings_ms ?? 0))
    .slice(0, 20);
}

function ratingFromScore(score) {
  if (typeof score !== "number") return "unknown";
  if (score >= 0.9) return "good";
  if (score >= 0.5) return "needs_improvement";
  return "poor";
}

function assessRisk(score, poorCount, needsImprovementCount) {
  const scoreText = score === null ? "unknown score" : `score ${Math.round(score * 100)}`;

  if (score !== null && score < 0.5) {
    return {
      level: "medium",
      summary: `Lighthouse performance ${scoreText}; ${poorCount} metric(s) are poor.`,
    };
  }

  if (poorCount > 0 || needsImprovementCount > 0) {
    return {
      level: "low",
      summary: `Lighthouse performance ${scoreText}; ${poorCount + needsImprovementCount} metric(s) need review.`,
    };
  }

  return {
    level: "info",
    summary: `Lighthouse performance ${scoreText}; no poor metrics were reported.`,
  };
}

function renderMarkdown(record) {
  const value = record.value;
  const metrics = Array.isArray(value.metrics) ? value.metrics : [];
  const opportunities = Array.isArray(value.opportunities) ? value.opportunities : [];

  return [
    `# Lighthouse Performance: ${record.normalized_target}`,
    "",
    `- Status: ${record.status}`,
    `- Risk: ${record.risk.level}`,
    `- Summary: ${record.risk.summary}`,
    `- Final URL: ${value.final_url ?? "unknown"}`,
    `- Strategy: ${value.strategy ?? "unknown"}`,
    `- Performance score: ${value.performance_score === null || value.performance_score === undefined ? "unknown" : Math.round(value.performance_score * 100)}`,
    "",
    "## Metrics",
    "",
    "| Metric | Value | Rating |",
    "| --- | ---: | --- |",
    ...metrics.map((metric) => `| ${metric.label} | ${formatMetric(metric)} | ${metric.rating} |`),
    "",
    "## Opportunities",
    "",
    "| Audit | Savings ms | Savings bytes |",
    "| --- | ---: | ---: |",
    ...opportunities.map((item) => `| ${escapePipe(item.title)} | ${item.estimated_savings_ms ?? ""} | ${item.estimated_savings_bytes ?? ""} |`),
    "",
  ].join("\n");
}

function formatMetric(metric) {
  if (metric.display_value) return escapePipe(metric.display_value);
  if (metric.value === null || metric.value === undefined) return "";
  if (metric.unit === "ms") return `${Math.round(metric.value)} ms`;
  return String(metric.value);
}

function escapePipe(value) {
  return String(value).replace(/\|/g, "\\|");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
