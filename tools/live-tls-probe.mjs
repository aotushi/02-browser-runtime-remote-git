#!/usr/bin/env node
import tls from "node:tls";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.target) {
  console.error("Usage: npm run probe:tls -- https://example.com [--out snapshots/example.com-live-tls.json]");
  process.exit(1);
}

const startedAt = Date.now();
const snapshotAt = new Date().toISOString();
const target = normalizeUrl(args.target);
const targetUrl = new URL(target);
const normalizedTarget = targetUrl.hostname.toLowerCase();
const date = snapshotAt.slice(0, 10);
const outputPath = args.out || `snapshots/${normalizedTarget}-live-tls-${date}.json`;
const reportPath = args.report || `reports/${normalizedTarget}-live-tls-${date}.md`;

try {
  const tlsResult = await probeLiveCertificate(targetUrl.hostname, Number(targetUrl.port || 443));
  const record = createRecord({
    target,
    normalizedTarget,
    snapshotAt,
    durationMs: Date.now() - startedAt,
    tlsResult,
  });
  const artifact = { records: [record] };

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
    error: message,
  });
  const artifact = { records: [record] };

  await writeJson(outputPath, artifact);
  await writeText(reportPath, renderMarkdown(record));

  console.error(message);
  process.exitCode = 2;
}

function parseArgs(values) {
  const result = { target: "", out: "", report: "" };

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

    if (!result.target) result.target = value;
  }

  return result;
}

function normalizeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function probeLiveCertificate(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        timeout: 15_000,
      },
      () => {
        const peerCertificate = socket.getPeerCertificate(true);
        const result = {
          host,
          port,
          authorized: socket.authorized,
          authorization_error: socket.authorizationError ? String(socket.authorizationError) : null,
          protocol: socket.getProtocol(),
          cipher: socket.getCipher(),
          certificate: normalizeCertificate(peerCertificate),
          chain: normalizeCertificateChain(peerCertificate),
        };
        socket.end();
        resolve(result);
      },
    );

    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("TLS socket timed out."));
    });
    socket.once("error", reject);
  });
}

function normalizeCertificate(cert) {
  if (!cert || Object.keys(cert).length === 0) return null;

  return {
    subject: cert.subject ?? null,
    issuer: cert.issuer ?? null,
    subject_alt_names: parseSubjectAltName(cert.subjectaltname),
    valid_from: cert.valid_from ?? null,
    valid_to: cert.valid_to ?? null,
    fingerprint256: cert.fingerprint256 ?? null,
    serial_number: cert.serialNumber ?? null,
    raw_subject_alt_name: cert.subjectaltname ?? null,
  };
}

function normalizeCertificateChain(cert) {
  const chain = [];
  const seen = new Set();
  let current = cert;

  while (current && Object.keys(current).length > 0) {
    const key = current.fingerprint256 ?? current.serialNumber ?? JSON.stringify(current.subject ?? {});
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(normalizeCertificate(current));
    current = current.issuerCertificate;
  }

  return chain.filter(Boolean);
}

function parseSubjectAltName(value) {
  if (!value) return [];

  return value
    .split(/,\s*/)
    .map((item) => item.replace(/^DNS:/i, "").trim())
    .filter(Boolean);
}

function createRecord(input) {
  const certificate = input.tlsResult.certificate;
  const expiresAt = certificate?.valid_to ? Date.parse(certificate.valid_to) : null;
  const daysUntilExpiry = expiresAt ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null;
  const risk = assessRisk(input.tlsResult, daysUntilExpiry);

  return {
    target: input.target,
    normalized_target: input.normalizedTarget,
    snapshot_at: input.snapshotAt,
    probe: "tls_live_certificate_probe",
    layer: 2,
    item: "tls_live_certificate",
    probe_type: "node_tls",
    source: "github_actions_node_tls_socket",
    status: risk.level === "high" || risk.level === "medium" ? "warning" : "ok",
    value: {
      host: input.tlsResult.host,
      port: input.tlsResult.port,
      authorized: input.tlsResult.authorized,
      authorization_error: input.tlsResult.authorization_error,
      protocol: input.tlsResult.protocol,
      cipher: input.tlsResult.cipher,
      certificate,
      chain: input.tlsResult.chain,
      days_until_expiry: daysUntilExpiry,
    },
    risk,
    evidence: [
      { type: "tls_protocol", value: input.tlsResult.protocol },
      { type: "tls_cipher", value: input.tlsResult.cipher },
      { type: "tls_certificate", name: "leaf", value: certificate },
      { type: "tls_certificate_chain", value: input.tlsResult.chain },
    ],
    evidence_metadata: {
      origin: "direct_observation",
      role: "raw",
      method: "tls_socket",
      limitations: [
        "Collected from a Node.js TLS socket in the GitHub Actions runner.",
        "The certificate reflects the runner network path and SNI target at collection time.",
        "OCSP, revocation status, and multi-region certificate variance are not checked.",
      ],
    },
    duration_ms: input.durationMs,
  };
}

function createErrorRecord(input) {
  return {
    target: input.target,
    normalized_target: input.normalizedTarget,
    snapshot_at: input.snapshotAt,
    probe: "tls_live_certificate_probe",
    layer: 2,
    item: "tls_live_certificate",
    probe_type: "node_tls",
    source: "github_actions_node_tls_socket",
    status: "error",
    value: {
      error: input.error,
    },
    risk: {
      level: "high",
      summary: `Live TLS certificate inspection failed: ${input.error}`,
    },
    evidence: [{ type: "error", value: input.error }],
    evidence_metadata: {
      origin: "direct_observation",
      role: "raw",
      method: "tls_socket",
      limitations: [
        "The probe failed before a live certificate could be collected.",
        "A failure may be caused by network policy, SNI mismatch, TLS version support, or target availability.",
      ],
    },
    duration_ms: input.durationMs,
    error: input.error,
  };
}

function assessRisk(tlsResult, daysUntilExpiry) {
  if (!tlsResult.authorized) {
    return {
      level: "medium",
      summary: `TLS certificate was collected, but Node did not authorize the chain: ${
        tlsResult.authorization_error ?? "unknown error"
      }.`,
    };
  }

  if (daysUntilExpiry === null) {
    return {
      level: "medium",
      summary: "Live certificate was collected, but expiry could not be parsed.",
    };
  }

  if (daysUntilExpiry < 0) {
    return {
      level: "high",
      summary: `Live certificate expired ${Math.abs(daysUntilExpiry)} day(s) ago.`,
    };
  }

  if (daysUntilExpiry <= 14) {
    return {
      level: "high",
      summary: `Live certificate expires in ${daysUntilExpiry} day(s).`,
    };
  }

  if (daysUntilExpiry <= 30) {
    return {
      level: "medium",
      summary: `Live certificate expires in ${daysUntilExpiry} day(s).`,
    };
  }

  return {
    level: "info",
    summary: `Live certificate expires in ${daysUntilExpiry} day(s).`,
  };
}

function renderMarkdown(record) {
  const value = record.value;
  const certificate = value.certificate ?? {};

  return `# Live TLS Certificate Report

Target: ${record.target}

Snapshot: ${record.snapshot_at}

Status: ${record.status}

Risk: ${record.risk.level} - ${record.risk.summary}

## Certificate

- Host: ${value.host ?? "n/a"}
- Authorized: ${String(value.authorized ?? "n/a")}
- Protocol: ${value.protocol ?? "n/a"}
- Cipher: ${value.cipher?.standardName ?? value.cipher?.name ?? "n/a"}
- Subject CN: ${certificate.subject?.CN ?? "n/a"}
- Issuer CN: ${certificate.issuer?.CN ?? "n/a"}
- Valid from: ${certificate.valid_from ?? "n/a"}
- Valid to: ${certificate.valid_to ?? "n/a"}
- Days until expiry: ${String(value.days_until_expiry ?? "n/a")}
- SAN: ${(certificate.subject_alt_names ?? []).join(", ") || "n/a"}

## Artifact

This report is generated from the same SnapshotRecord JSON uploaded in the workflow artifact.
`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
