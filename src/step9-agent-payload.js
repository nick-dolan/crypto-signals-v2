import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildAgentPayload } from "./steps/step9-agent-payload/build-agent-payload.js"

async function runAgentPayloadStep () {
  const [shortlist, context, patterns] = await Promise.all([
    readTmpJson("step5-preliminary-filter.json"),
    readTmpJson("step8-context-enrichment.json"),
    readTmpJson("step8.1-pattern-enrichment.json").catch((error) => {
      if (error.code === "ENOENT") {
        throw new Error("Step 9 requires tmp/step8.1-pattern-enrichment.json; run step 8.1 pattern enrichment first", { cause: error })
      }
      throw error
    }),
  ])
  if (patterns === null) {
    throw new Error("Step 8.1 pattern enrichment report must not be null; rerun step 8.1 before step 9")
  }
  const payload = buildAgentPayload(shortlist, context, patterns)
  const outputPath = await writeTmpJson("step9-agent-payload.json", payload)

  console.log(
    `✓ Saved ${payload.candidateCount} compact agent candidates with ${Object.keys(payload.schema).length} groups to ${outputPath}`,
  )
}

await runStep("step9-agent-payload.js", runAgentPayloadStep)
