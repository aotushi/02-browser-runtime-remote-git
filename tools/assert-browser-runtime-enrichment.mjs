#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const snapshotPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!snapshotPath) {
  console.error("Usage: node tools/assert-browser-runtime-enrichment.mjs <snapshot.json>");
  process.exit(1);
}

const records = JSON.parse(await readFile(snapshotPath, "utf-8"));
const browserRecord = Array.isArray(records)
  ? records.find((record) => record?.probe === "browser_page_probe")
  : null;

if (!browserRecord) {
  throw new Error("browser_page_probe record was not found.");
}

const value = browserRecord.value;

if (!value || typeof value !== "object") {
  throw new Error("browser_page_probe.value is missing.");
}

if (!Array.isArray(value.resources)) {
  throw new Error("browser_page_probe.value.resources must be an array.");
}

if (!Array.isArray(value.console_messages)) {
  throw new Error("browser_page_probe.value.console_messages must be an array.");
}

if (!Array.isArray(value.page_errors)) {
  throw new Error("browser_page_probe.value.page_errors must be an array.");
}

if (!value.runtime_security || typeof value.runtime_security !== "object") {
  throw new Error("browser_page_probe.value.runtime_security is missing.");
}

const resource = value.resources[0];

if (!resource) {
  throw new Error("browser_page_probe.value.resources is empty.");
}

const requiredResourceKeys = [
  "request_id",
  "domain",
  "same_origin",
  "content_type",
  "cache_control",
  "cdn_headers",
  "transfer_size",
  "encoded_body_size",
  "decoded_body_size",
  "duration_ms",
  "start_time_ms",
  "timing_source",
];

for (const key of requiredResourceKeys) {
  if (!(key in resource)) {
    throw new Error(`browser runtime resource is missing ${key}.`);
  }
}

for (const key of ["mixed_content_candidates", "failed_request_count", "console_error_count"]) {
  if (!(key in value.runtime_security)) {
    throw new Error(`runtime_security is missing ${key}.`);
  }
}

console.log(`Runtime enrichment check passed: ${snapshotPath}`);
