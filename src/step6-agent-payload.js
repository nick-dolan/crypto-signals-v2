import { readTmpJson, writeTmpCompactJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildAgentPayload } from "./steps/step6-agent-payload/build-agent-payload.js"

async function runAgentPayloadStep () {
  const shortlist = await readTmpJson("step5-preliminary-filter.json")
  const payload = buildAgentPayload(shortlist)
  const outputPath = await writeTmpCompactJson("step6-agent-payload.json", payload)

  console.log(
    `✓ Saved ${payload.candidateCount} compact agent rows with ${payload.schema.length} columns to ${outputPath}`,
  )
}

await runStep("step6-agent-payload.js", runAgentPayloadStep)
