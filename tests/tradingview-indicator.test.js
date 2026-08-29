import assert from "node:assert/strict"
import test from "node:test"
import {
  createTradingViewIndicatorResolver,
} from "../src/api/tradingview/studies/index.js"

class FakePineIndicator {
  constructor (options) {
    this.options = options
    this.indicatorType = "Script@tv-scripting-101!"
  }

  get pineId () {
    return this.options.pineId
  }

  get pineVersion () {
    return this.options.pineVersion
  }

  get description () {
    return this.options.description
  }

  get shortDescription () {
    return this.options.shortDescription
  }

  get inputs () {
    return this.options.inputs
  }

  get plots () {
    return this.options.plots
  }

  get script () {
    return this.options.script
  }

  get type () {
    return this.indicatorType
  }

  setType (type) {
    this.indicatorType = type
  }

  setOption (key, value) {
    const inputKey = Object.keys(this.inputs).find(input => (
      input === key
      || this.inputs[input].inline === key
      || this.inputs[input].internalID === key
    ))

    if (!inputKey) {
      throw new Error(`Input ${key} not found`)
    }

    this.inputs[inputKey].value = value
  }
}

function createSourceIndicator () {
  return {
    pineId: "STD;EMA",
    pineVersion: "42.0",
    description: "Moving Average Exponential",
    shortDescription: "EMA",
    type: "Script@tv-scripting-101!",
    inputs: {
      in_0: {
        name: "Length",
        inline: "Length",
        internalID: "Length",
        type: "integer",
        value: 9,
        options: [9, 20, 50, 200],
      },
    },
    plots: {
      plot_0: "EMA",
    },
    script: "compiled-pine-script",
  }
}

test("resolver caches metadata and creates independent indicator instances", async () => {
  const sourceIndicator = createSourceIndicator()
  let loadCount = 0
  const resolver = createTradingViewIndicatorResolver({
    loadIndicator: async () => {
      loadCount += 1
      return sourceIndicator
    },
    PineIndicator: FakePineIndicator,
  })

  const [leftMetadata, rightMetadata] = await Promise.all([
    resolver.resolve("STD;EMA", "last"),
    resolver.resolve("STD;EMA", "last"),
  ])

  assert.equal(loadCount, 1)
  assert.equal(leftMetadata.version, "42.0")
  assert.deepEqual(leftMetadata, rightMetadata)
  assert.equal(Object.isFrozen(leftMetadata), true)
  assert.equal(Object.isFrozen(leftMetadata.inputs), true)
  assert.equal(Object.isFrozen(leftMetadata.inputs.in_0), true)
  assert.equal(Object.isFrozen(leftMetadata.inputs.in_0.options), true)

  const [ema50, ema200] = await Promise.all([
    resolver.create({
      id: "STD;EMA",
      inputs: { Length: 50 },
    }),
    resolver.create({
      id: "STD;EMA",
      inputs: { Length: 200 },
    }),
  ])

  assert.equal(loadCount, 1)
  assert.notEqual(ema50.indicator, ema200.indicator)
  assert.equal(ema50.indicator.inputs.in_0.value, 50)
  assert.equal(ema200.indicator.inputs.in_0.value, 200)
  assert.equal(ema50.metadata.inputs.in_0.value, 50)
  assert.equal(ema200.metadata.inputs.in_0.value, 200)
  assert.equal(sourceIndicator.inputs.in_0.value, 9)

  await assert.rejects(
    resolver.create({
      id: "STD;EMA",
      inputs: { Unknown: 10 },
    }),
    /Invalid input Unknown for TradingView indicator STD;EMA/,
  )

  resolver.clear()
  await resolver.resolve("STD;EMA", "last")
  assert.equal(loadCount, 2)
})

test("resolver evicts rejected metadata requests so they can be retried", async () => {
  let loadCount = 0
  const resolver = createTradingViewIndicatorResolver({
    loadIndicator: async () => {
      loadCount += 1

      if (loadCount === 1) {
        throw new Error("Temporary failure")
      }

      return createSourceIndicator()
    },
    PineIndicator: FakePineIndicator,
  })

  await assert.rejects(
    resolver.resolve("STD;EMA", "last"),
    /Temporary failure/,
  )

  const metadata = await resolver.resolve("STD;EMA", "last")

  assert.equal(loadCount, 2)
  assert.equal(metadata.id, "STD;EMA")
})
