import { writeTmpJson } from "./helpers/fs-helper.js"
import { buildCryptoUniverse } from "./steps/step1-crypto-universe/build-crypto-universe.js"

import { fetchCryptoUniverseCandidates } from "./steps/step1-crypto-universe/fetch-crypto-universe-candidates.js"

async function runCryptoUniverseStep () {
  const candidates = await fetchCryptoUniverseCandidates()
  const universe = buildCryptoUniverse(candidates)

  const outputPath = await writeTmpJson("step1-crypto-universe.json", universe)

  console.log(`✓ Saved ${universe.coinCount} candidate coins to ${outputPath}`)
  console.log(`✓ Excluded ${universe.excludedStablecoinCount} stablecoins`)
}

await runCryptoUniverseStep()
