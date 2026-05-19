import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Request, type Response } from "playwright";
import { targetSlug } from "../core/normalize-target.js";
import type { BrowserProvider } from "./provider.js";
import type { BrowserPageSnapshot, ResourceSummary } from "../core/types.js";

type ResourceEvent = {
  url: string;
  method: string;
  resource_type: string;
  status_code: number | null;
  failure: string | null;
};

export const playwrightLocalProvider: BrowserProvider = {
  name: "playwright-local",
  async snapshotPage({ target, snapshotAt, options }) {
    const resources = new Map<Request, ResourceEvent>();
    const browser = await chromium.launch({ headless: !options.headed });

    try {
      const context = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        deviceScaleFactor: 1,
        locale: "en-US",
      });
      const page = await context.newPage();

      page.on("request", (request) => {
        resources.set(request, {
          url: request.url(),
          method: request.method(),
          resource_type: request.resourceType(),
          status_code: null,
          failure: null,
        });
      });

      page.on("response", (response: Response) => {
        const request = response.request();
        const existing = resources.get(request);
        if (existing) {
          existing.status_code = response.status();
        }
      });

      page.on("requestfailed", (request) => {
        const existing = resources.get(request);
        if (existing) {
          existing.failure = request.failure()?.errorText ?? "request failed";
        }
      });

      const response = await page.goto(target.url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });

      await waitForPageSettled(page, options.waitMs, options.timeoutMs);

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
      const resourceList = Array.from(resources.values());
      const accessBarrier = detectAccessBarrier(title, html, visibleText);

      await context.close();

      return {
        final_url: finalUrl,
        status_code: response?.status() ?? null,
        title,
        html_bytes: Buffer.byteLength(html, "utf-8"),
        visible_text_bytes: Buffer.byteLength(visibleText, "utf-8"),
        resource_counts: summarizeResources(resourceList),
        resources: resourceList.slice(0, 80),
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

function summarizeResources(resources: ResourceEvent[]): ResourceSummary {
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
