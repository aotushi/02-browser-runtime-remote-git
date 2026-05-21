#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { stdout: helpOutput } = await execFileAsync(process.execPath, ["dist/cli.js", "--help"], {
  windowsHide: true,
});

if (!helpOutput.includes("--provider <id>")) {
  throw new Error("CLI help must document --provider <id>.");
}

if (!helpOutput.includes("playwright-local") || !helpOutput.includes("github-actions-browser")) {
  throw new Error("CLI help must document supported browser runtime providers.");
}

const workflow = await readFile(".github/workflows/site-10-layer-check-browser.yml", "utf-8");

if (!/provider:\s*\n\s*description:/m.test(workflow)) {
  throw new Error("Browser runtime workflow must expose a provider workflow_dispatch input.");
}

if (!workflow.includes('--provider "${{ inputs.provider }}"')) {
  throw new Error("Browser runtime workflow must pass the selected provider to the CLI.");
}

console.log("Browser runtime provider selection check passed.");
