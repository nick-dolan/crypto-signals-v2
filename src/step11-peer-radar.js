import { writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildPeerRadar } from "./steps/step11-peer-radar/build-peer-radar.js"
import { readPeerRadarInput } from "./steps/step11-peer-radar/read-peer-radar-input.js"

async function runPeerRadarStep () {
  const scan = buildPeerRadar(await readPeerRadarInput())
  const outputPath = await writeTmpJson("step11-peer-radar.json", scan)

  console.log(`✓ Found ${scan.candidateCount} peer-reaction discrepancies across ${scan.loadedCoinCount} loaded coins; saved to ${outputPath}`)
  if (scan.registryGeneratedAt === null) {
    console.warn("⚠ Peer registry is unavailable; an empty scan does not mean there are no market discrepancies")
  }
}

await runStep("step11-peer-radar.js", runPeerRadarStep)
