import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildAgentPayload } from "./steps/step9-agent-payload/build-agent-payload.js"

async function runAgentPayloadStep () {
  const [shortlist, context] = await Promise.all([
    readTmpJson("step5-preliminary-filter.json"),
    readTmpJson("step8-context-enrichment.json"),
  ])
  const payload = buildAgentPayload(shortlist, context)
  const outputPath = await writeTmpJson("step9-agent-payload.json", payload)

  console.log(
    `✓ Saved ${payload.candidateCount} compact agent candidates with ${Object.keys(payload.schema).length} groups to ${outputPath}`,
  )
}

await runStep("step9-agent-payload.js", runAgentPayloadStep)
