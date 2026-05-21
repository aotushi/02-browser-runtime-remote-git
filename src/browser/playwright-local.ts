import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Request, type Response } from "playwright";
import { targetSlug } from "../core/normalize-target.js";
import type { BrowserProvider } from "./provider.js";
import type { BrowserConsoleMessage, BrowserPageResource, BrowserPageSnapshot, ResourceSummary } from "../core/types.js";

type PerformanceTimingEntry = {
  name: string;
  entry_type: "resource" | "navigation";
  initiator_type: string;
  transfer_size: number | null;
  encoded_body_size: number | null;
  decoded_body_size: number | null;
  duration_ms: number | null;
  start_time_ms: number | null;
};

const MAX_RESOURCES = 120;
const MAX_CONSOLE_MESSAGES = 80;
const MAX_PAGE_ERRORS = 20;
const CDN_HEADER_NAMES = [
  "cf-ray",
  "cf-cache-status",
  "server",
  "x-cache",
  "x-cache-hits",
  "via",
  "x-vercel-id",
  "x-served-by",
  "x-fastly-request-id",
  "x-akamai-transformed",
  "x-amz-cf-pop",
  "x-amz-cf-id",
  "x-cache-status",
];

export const playwrightLocalProvider: BrowserProvider = {
  name: "playwright-local",
  async snapshotPage({ target, snapshotAt, options }) {
    const resources = new Map<Request, BrowserPageResource>();
    const consoleMessages: BrowserConsoleMessage[] = [];
    const pageErrors: string[] = [];
    let requestIndex = 0;
    const browser = await chromium.launch({ headless: !options.headed });

    try {
      const context = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        deviceScaleFactor: 1,
        locale: "en-US",
      });
      const page = await context.newPage();

      page.on("request", (request) => {
        requestIndex += 1;
        resources.set(request, {
          request_id: `req_${requestIndex}`,
          url: request.url(),
          method: request.method(),
          resource_type: request.resourceType(),
          status_code: null,
          failure: null,
          domain: readHostname(request.url()),
          same_origin: isSameOrigin(target.origin, request.url()),
          content_type: null,
          cache_control: null,
          cdn_headers: {},
          transfer_size: null,
          encoded_body_size: null,
          decoded_body_size: null,
          duration_ms: null,
          start_time_ms: null,
          timing_source: "not_available",
        });
      });

      page.on("response", (response: Response) => {
        const request = response.request();
        const existing = resources.get(request);
        if (existing) {
          const headers = response.headers();
          existing.status_code = response.status();
          existing.content_type = headers["content-type"] ?? null;
          existing.cache_control = headers["cache-control"] ?? null;
          existing.cdn_headers = pickHeaders(headers, CDN_HEADER_NAMES);
          existing.timing_source = existing.timing_source === "not_available" ? "playwright_response" : existing.timing_source;
        }
      });

      page.on("requestfailed", (request) => {
        const existing = resources.get(request);
        if (existing) {
          existing.failure = request.failure()?.errorText ?? "request failed";
        }
      });

      page.on("console", (message) => {
        if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
          return;
        }
        const location = message.location();
        consoleMessages.push({
          type: message.type(),
          text: message.text().slice(0, 1200),
          location: formatConsoleLocation(location.url, location.lineNumber, location.columnNumber),
        });
      });

      page.on("pageerror", (error) => {
        if (pageErrors.length >= MAX_PAGE_ERRORS) {
          return;
        }
        pageErrors.push(error.message.slice(0, 1200));
      });

      const response = await page.goto(target.url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });

      await waitForPageSettled(page, options.waitMs, options.timeoutMs);
      const timingEntries = await readPerformanceTimingEntries(page);

      const title = await page.title();
      const html = await page.content();
      const visibleText = await readVisibleText(page);
      const finalUrl = page.url();
      const screenshotPath = options.screenshot
        ? await saveScreenshot({
            page,
            targetSlug: targetSlug(target.normalizedTarget),
            snapshotAt,
            screenshotsDir: options.screenshotsDir,
          })
        : null;
      const resourceList = enrichResourcesWithTimings(Array.from(resources.values()), timingEntries);
      const accessBarrier = detectAccessBarrier(title, html, visibleText);
      const runtimeSecurity = summarizeRuntimeSecurity(finalUrl, resourceList, consoleMessages);

      await context.close();

      return {
        final_url: finalUrl,
        status_code: response?.status() ?? null,
        title,
        html_bytes: Buffer.byteLength(html, "utf-8"),
        visible_text_bytes: Buffer.byteLength(visibleText, "utf-8"),
        resource_counts: summarizeResources(resourceList),
        resources: resourceList.slice(0, MAX_RESOURCES),
        console_messages: consoleMessages,
        page_errors: pageErrors,
        runtime_security: runtimeSecurity,
        screenshot_path: screenshotPath,
        access_barrier: accessBarrier,
      };
    } finally {
      await browser.close();
    }
  },
};

async function waitForPageSettled(page: Page, waitMs: number, timeoutMs: number) {
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10000) });
  } catch {
    // Some pages keep analytics, long polling, or streaming requests open.
  }

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

async function saveScreenshot(input: {
  page: Page;
  targetSlug: string;
  snapshotAt: string;
  screenshotsDir: string;
}) {
  await mkdir(input.screenshotsDir, { recursive: true });
  const stamp = input.snapshotAt.slice(0, 10);
  const screenshotPath = path.join(input.screenshotsDir, `${input.targetSlug}-${stamp}.png`);
  await input.page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function readVisibleText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 3000 });
  } catch {
    return "";
  }
}

async function readPerformanceTimingEntries(page: Page): Promise<PerformanceTimingEntry[]> {
  try {
    return await page.evaluate(() => {
      const resourceEntries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const navigationEntries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];

      const normalize = (
        entry: PerformanceResourceTiming | PerformanceNavigationTiming,
        entryType: "resource" | "navigation",
      ) => ({
        name: entry.name,
        entry_type: entryType,
        initiator_type: "initiatorType" in entry ? entry.initiatorType : "navigation",
        transfer_size: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
        encoded_body_size: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
        decoded_body_size: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
        duration_ms: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
        start_time_ms: Number.isFinite(entry.startTime) ? Math.round(entry.startTime) : null,
      });

      return [
        ...navigationEntries.map((entry) => normalize(entry, "navigation")),
        ...resourceEntries.map((entry) => normalize(entry, "resource")),
      ];
    });
  } catch {
    return [];
  }
}

function enrichResourcesWithTimings(
  resources: BrowserPageResource[],
  timingEntries: PerformanceTimingEntry[],
): BrowserPageResource[] {
  const timingsByUrl = new Map<string, PerformanceTimingEntry[]>();

  for (const entry of timingEntries) {
    const entries = timingsByUrl.get(entry.name) ?? [];
    entries.push(entry);
    timingsByUrl.set(entry.name, entries);
  }

  return resources.map((resource) => {
    const timing = timingsByUrl.get(resource.url)?.shift();

    if (!timing) {
      return resource;
    }

    return {
      ...resource,
      transfer_size: timing.transfer_size,
      encoded_body_size: timing.encoded_body_size,
      decoded_body_size: timing.decoded_body_size,
      duration_ms: timing.duration_ms,
      start_time_ms: timing.start_time_ms,
      timing_source:
        timing.entry_type === "navigation" ? "performance_navigation_timing" : "performance_resource_timing",
    };
  });
}

function summarizeResources(resources: BrowserPageResource[]): ResourceSummary {
  const counts: ResourceSummary = {
    document: 0,
    script: 0,
    stylesheet: 0,
    image: 0,
    font: 0,
    xhr: 0,
    fetch: 0,
    other: 0,
  };

  for (const resource of resources) {
    if (resource.resource_type in counts) {
      counts[resource.resource_type as keyof ResourceSummary] += 1;
    } else {
      counts.other += 1;
    }
  }

  return counts;
}

function summarizeRuntimeSecurity(
  finalUrl: string,
  resources: BrowserPageResource[],
  consoleMessages: BrowserConsoleMessage[],
): BrowserPageSnapshot["runtime_security"] {
  const mixedContentCandidates = new Map<string, { url: string; resource_type: string; reason: string }>();
  const finalProtocol = readProtocol(finalUrl);

  if (finalProtocol === "https:") {
    for (const resource of resources) {
      if (readProtocol(resource.url) === "http:") {
        mixedContentCandidates.set(resource.url, {
          url: resource.url,
          resource_type: resource.resource_type,
          reason: "HTTP resource observed from an HTTPS page.",
        });
      }
    }
  }

  for (const message of consoleMessages) {
    if (/mixed content/i.test(message.text)) {
      mixedContentCandidates.set(`console:${message.text}`, {
        url: message.location ?? "",
        resource_type: "console",
        reason: message.text.slice(0, 240),
      });
    }
  }

  return {
    mixed_content_candidates: Array.from(mixedContentCandidates.values()),
    failed_request_count: resources.filter((resource) => resource.failure || (resource.status_code ?? 0) >= 400).length,
    console_error_count: consoleMessages.filter((message) => message.type === "error").length,
  };
}

function readHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function readProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function isSameOrigin(origin: string, url: string): boolean | null {
  try {
    return new URL(url).origin === origin;
  } catch {
    return null;
  }
}

function formatConsoleLocation(url: string, lineNumber: number, columnNumber: number): string | null {
  if (!url) {
    return null;
  }

  const suffix = lineNumber > 0 ? `:${lineNumber}:${columnNumber}` : "";
  return `${url}${suffix}`;
}

function pickHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const name of names) {
    const value = headers[name];
    if (value) {
      selected[name] = value;
    }
  }

  return selected;
}

function detectAccessBarrier(title: string, html: string, visibleText: string) {
  const lowerTitle = title.toLowerCase();
  const lowerHtml = html.toLowerCase();
  const lowerVisibleText = visibleText.toLowerCase();
  const types = new Set<string>();

  if (
    lowerTitle.includes("just a moment") ||
    lowerHtml.includes("cf-mitigated") ||
    lowerHtml.includes("challenge-platform") ||
    lowerVisibleText.includes("checking if the site connection is secure")
  ) {
    types.add("cloudflare_challenge");
  }

  if (
    /verify you are human|complete the security check|captcha verification|i am not a robot/.test(lowerVisibleText)
  ) {
    types.add("captcha");
  }

  if (/access denied|forbidden|request blocked|bot detection/.test(lowerVisibleText)) {
    types.add("generic_access_denied");
  }

  return {
    detected: types.size > 0,
    types: Array.from(types),
    title,
    visible_text_sample: visibleText.replace(/\s+/g, " ").trim().slice(0, 240),
  };
}
