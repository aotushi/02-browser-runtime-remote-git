import type { NormalizedTarget } from "./types.js";

export function normalizeTarget(input: string): NormalizedTarget {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Target URL is required.");
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https targets are supported. Received: ${url.protocol}`);
  }

  url.hash = "";

  return {
    input,
    url,
    origin: url.origin,
    normalizedTarget: url.hostname.toLowerCase(),
  };
}

export function targetSlug(normalizedTarget: string): string {
  return normalizedTarget.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "target";
}
