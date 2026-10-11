import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { parseInteger } from "./helpers/normalization-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { runCandidateEnrichment } from "./steps/candidate-enrichment/run-candidate-enrichment.js"

export function parseCandidateEnrichmentArgs (args) {
  const { values } = parseArgs({
    args,
    options: { concurrency: { type: "string", default: "10" } },
  })
  const concurrency = parseInteger(values.concurrency, "Candidate enrichment concurrency")
  if (concurrency < 1 || concurrency > 10) {
    throw new Error("Candidate enrichment concurrency must be between 1 and 10")
  }
  return { concurrency }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("candidate-enrichment.js", () => runCandidateEnrichment(
    parseCandidateEnrichmentArgs(process.argv.slice(2)),
  ))
}
