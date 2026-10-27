import assert from "node:assert/strict"
import test from "node:test"
import { getIndicator } from "@mathieuc/tradingview"

import { createTradingViewIndicatorResolver } from "../src/api/tradingview/studies/resolver.js"

function createDefinition () {
  return {
    metaInfo: {
      scriptIdPart: "STD;Fixture",
      pine: { version: "7.0" },
      description: "Fixture",
      shortDescription: "Fixture",
      defaults: { inputs: { text: "default-script" } },
      inputs: [
        { id: "text", name: "Text", type: "text", defval: "default-script" },
        { id: "in_0", name: "Symbol", type: "symbol", defval: "" },
      ],
      styles: { plot_0: { title: "Metric" } },
      plots: [{ id: "plot_0", type: "line" }],
    },
  }
}

for (const legacy of [true, false]) {
  test(`indicator loader preserves ${legacy ? "legacy ilTemplate" : "current default text"} and isolates cached symbol inputs`, async (t) => {
    const definition = createDefinition()
    if (legacy) {
      definition.ilTemplate = "legacy-script"
    }
    const fetch = t.mock.fn(async () => Response.json({ success: true, result: definition }))
    const resolver = createTradingViewIndicatorResolver({
      loadIndicator: (id, version) => getIndicator(id, { version, fetch }),
    })
    const first = await resolver.create({
      id: "STD;Fixture", inputs: { in_0: "CRYPTO:BTCUSD" },
    })
    const second = await resolver.create({
      id: "STD;Fixture", inputs: { in_0: "CRYPTO:ETHUSD" },
    })

    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(first.indicator.id, "STD;Fixture")
    assert.equal(first.indicator.version, "7.0")
    assert.equal(first.indicator.toStudyInputs().text, legacy ? "legacy-script" : "default-script")
    assert.equal(first.indicator.toStudyInputs().in_0.v, "CRYPTO:BTCUSD")
    assert.equal(second.indicator.toStudyInputs().in_0.v, "CRYPTO:ETHUSD")
    assert.equal(first.metadata.inputs.in_0.value, "CRYPTO:BTCUSD")
    assert.equal(second.metadata.inputs.in_0.value, "CRYPTO:ETHUSD")
    assert.equal((await resolver.resolve("STD;Fixture")).inputs.in_0.value, "")
  })
}

test("indicator without a compiled script is rejected before creating a study", async () => {
  const definition = createDefinition()
  delete definition.metaInfo.defaults.inputs.text
  const resolver = createTradingViewIndicatorResolver({
    loadIndicator: (id, version) => getIndicator(id, {
      version,
      fetch: async () => Response.json({ success: true, result: definition }),
    }),
  })

  await assert.rejects(resolver.create({ id: "STD;Fixture" }), /script is required/)
})
