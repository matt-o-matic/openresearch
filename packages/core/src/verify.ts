import type { CitationPolicy } from "./config.js";
import type { ExtractedEvidence } from "./extract.js";
import type { CitationMap } from "./memo.js";

export type VerificationIssueSeverity = "error" | "warn";
export type VerificationIssue = {
  severity: VerificationIssueSeverity;
  code: string;
  message: string;
  claimId?: string;
  sourceLabel?: string;
};

export type VerificationReport = {
  version: 1;
  runId: string;
  ok: boolean;
  createdAt: string;
  coverage: {
    totalClaims: number;
    claimsWithCitations: number;
    totalSources: number;
    citedSources: number;
  };
  issues: VerificationIssue[];
};

function issue(
  severity: VerificationIssueSeverity,
  code: string,
  message: string,
  extra?: Partial<VerificationIssue>
): VerificationIssue {
  return { severity, code, message, ...extra };
}

export function validateCitations(input: {
  runId: string;
  policy: CitationPolicy;
  citationMap: CitationMap;
  evidenceBySourceId: Record<string, ExtractedEvidence | undefined>;
}): { report: VerificationReport; markdown: string } {
  const issues: VerificationIssue[] = [];
  const sourcesById = new Map(input.citationMap.sources.map((s) => [s.sourceId, s]));

  for (const s of input.citationMap.sources) {
    const ev = input.evidenceBySourceId[s.sourceId];
    if (!ev) {
      issues.push(
        issue("error", "missing_evidence", "Missing evidence for source", { sourceLabel: s.label })
      );
      continue;
    }
    if (!ev.contentText || ev.contentText.trim().length === 0) {
      issues.push(
        issue("error", "empty_extract", "Empty extract for source", { sourceLabel: s.label })
      );
    }
  }

  let claimsWithCitations = 0;
  const citedSourceLabels = new Set<string>();

  for (const claim of input.citationMap.claims) {
    if (claim.citations.length > 0) claimsWithCitations++;
    const missingSeverity: VerificationIssueSeverity = input.policy === "strict" ? "error" : "warn";
    if (claim.citations.length === 0) {
      issues.push(
        issue(missingSeverity, "missing_citations", "Claim has no citations", { claimId: claim.id })
      );
      continue;
    }

    if (Array.isArray(claim.unresolvedQuoteReferences)) {
      const unresolvedSeverity: VerificationIssueSeverity =
        input.policy === "strict" ? "error" : "warn";
      for (const unresolved of claim.unresolvedQuoteReferences) {
        issues.push(
          issue(
            unresolvedSeverity,
            "unresolved_quote_reference",
            `Citation references missing quoteId "${unresolved.quoteId}"`,
            {
              claimId: claim.id,
              sourceLabel: unresolved.sourceLabel,
            }
          )
        );
      }
    }

    for (const cit of claim.citations) {
      citedSourceLabels.add(cit.sourceLabel);
      const sourceRow = sourcesById.get(cit.sourceId);
      if (!sourceRow) {
        issues.push(
          issue("error", "unknown_source", "Citation references a source not present in the run", {
            claimId: claim.id,
            sourceLabel: cit.sourceLabel,
          })
        );
        continue;
      }

      const ev = input.evidenceBySourceId[cit.sourceId];
      if (!ev) continue;

      if (cit.quote) {
        const span = ev.contentText.slice(cit.quote.start, cit.quote.end);
        if (span !== cit.quote.text) {
          issues.push(
            issue("error", "quote_mismatch", "Citation quote offsets do not match stored content", {
              claimId: claim.id,
              sourceLabel: sourceRow.label,
            })
          );
        }
      }
    }
  }

  const report: VerificationReport = {
    version: 1,
    runId: input.runId,
    ok: !issues.some((i) => i.severity === "error"),
    createdAt: new Date().toISOString(),
    coverage: {
      totalClaims: input.citationMap.claims.length,
      claimsWithCitations,
      totalSources: input.citationMap.sources.length,
      citedSources: citedSourceLabels.size,
    },
    issues,
  };

  const md: string[] = [];
  md.push("# Verification report");
  md.push("");
  md.push(`Run: \`${input.runId}\``);
  md.push("");
  md.push(`Status: **${report.ok ? "OK" : "Issues found"}**`);
  md.push("");
  md.push("## Coverage");
  md.push("");
  md.push(
    `- Claims: ${report.coverage.claimsWithCitations}/${report.coverage.totalClaims} with citations`
  );
  md.push(`- Sources cited: ${report.coverage.citedSources}/${report.coverage.totalSources}`);
  md.push("");
  md.push("## Issues");
  md.push("");
  if (issues.length === 0) {
    md.push("- None.");
  } else {
    for (const i of issues) {
      const where = [
        i.claimId ? `claim=${i.claimId}` : null,
        i.sourceLabel ? `source=${i.sourceLabel}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      md.push(
        `- **${i.severity.toUpperCase()}** \`${i.code}\`${where ? ` (${where})` : ""}: ${i.message}`
      );
    }
  }
  md.push("");

  return { report, markdown: md.join("\n") };
}
