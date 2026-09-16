import assert from "node:assert/strict"
import test from "node:test"

import { calculateDivergenceFlags } from "../src/steps/step4-feature-metrics/metrics/divergence-flags.js"

function createInput (direction) {
  const sign = direction === "up" ? 1 : -1

  return {
    close: [100],
    movementLifecycle: {
      distance_to_previous_high_atr: [0.5],
      distance_to_previous_low_atr: [0.5],
    },
    volumeOrderFlow: {
      rel_volume_at_time: [1.5],
      vd_net_4h_over_volume: [sign * 0.1],
    },
    derivatives: {
      funding_rate: [-sign * 0.001],
      funding_percentile_90d: [direction === "up" ? 0.05 : 0.95],
      oi_level_percentile_90d: [0.8],
      oi_change_4h: [0.01],
      crowd_vs_top_traders: [-sign * 0.16],
    },
  }
}

function assertThresholds (input, flag, cases) {
  for (const [group, metric, values] of cases) {
    for (const [value, expected] of values) {
      const scenario = structuredClone(input)
      scenario[group][metric] = [value]
      assert.equal(
        calculateDivergenceFlags(scenario)[flag][0],
        expected,
        `${flag}: ${group}.${metric} = ${value}`,
      )
    }
  }
}

for (const direction of ["up", "down"]) {
  const sign = direction === "up" ? 1 : -1
  const rangeFlag = direction === "up" ? "range_pressure_up" : "range_pressure_down"
  const squeezeFlag = direction === "up" ? "short_squeeze_setup" : "long_squeeze_setup"
  const distanceMetric = direction === "up"
    ? "distance_to_previous_high_atr"
    : "distance_to_previous_low_atr"

  test(`${rangeFlag} uses inclusive distance, volume and signed delta thresholds`, () => {
    assertThresholds(createInput(direction), rangeFlag, [
      ["movementLifecycle", distanceMetric, [
        [-Number.MIN_VALUE, false],
        [0, true],
        [Number.MIN_VALUE, true],
        [0.5 - Number.EPSILON, true],
        [0.5, true],
        [0.5 + Number.EPSILON, false],
      ]],
      ["volumeOrderFlow", "rel_volume_at_time", [
        [1.5 - Number.EPSILON, false],
        [1.5, true],
        [1.5 + Number.EPSILON, true],
      ]],
      ["volumeOrderFlow", "vd_net_4h_over_volume", [
        [sign * (0.1 - Number.EPSILON), false],
        [sign * 0.1, true],
        [sign * (0.1 + Number.EPSILON), true],
        [0, false],
        [-sign * 0.1, false],
      ]],
    ])
  })

  test(`${squeezeFlag} requires the funding sign, extreme percentile, high rising OI and signed delta`, () => {
    assertThresholds(createInput(direction), squeezeFlag, [
      ["derivatives", "funding_rate", [
        [-sign * Number.MIN_VALUE, true],
        [0, false],
        [sign * Number.MIN_VALUE, false],
        [sign * 0.001, false],
      ]],
      ["derivatives", "funding_percentile_90d", direction === "up"
        ? [
            [0, true],
            [0.05 - Number.EPSILON, true],
            [0.05, true],
            [0.05 + Number.EPSILON, false],
            [0.95, false],
          ]
        : [
            [0.05, false],
            [0.95 - Number.EPSILON, false],
            [0.95, true],
            [0.95 + Number.EPSILON, true],
            [1, true],
          ]],
      ["derivatives", "oi_level_percentile_90d", [
        [0.8 - Number.EPSILON, false],
        [0.8, true],
        [0.8 + Number.EPSILON, true],
      ]],
      ["derivatives", "oi_change_4h", [
        [-0.01, false],
        [-Number.MIN_VALUE, false],
        [0, false],
        [Number.MIN_VALUE, true],
      ]],
      ["volumeOrderFlow", "vd_net_4h_over_volume", [
        [sign * (0.1 - Number.EPSILON), false],
        [sign * 0.1, true],
        [sign * (0.1 + Number.EPSILON), true],
        [0, false],
        [-sign * 0.1, false],
      ]],
    ])
  })

  test(`${rangeFlag} does not require derivatives or the opposite price level`, () => {
    const input = createInput(direction)
    delete input.derivatives
    delete input.movementLifecycle[direction === "up"
      ? "distance_to_previous_low_atr"
      : "distance_to_previous_high_atr"]

    assert.equal(calculateDivergenceFlags(input)[rangeFlag][0], true)
  })

  test(`${squeezeFlag} does not require volume growth, proximity to a level or trader disagreement`, () => {
    const input = createInput(direction)
    delete input.movementLifecycle
    delete input.volumeOrderFlow.rel_volume_at_time
    delete input.derivatives.crowd_vs_top_traders

    assert.equal(calculateDivergenceFlags(input)[squeezeFlag][0], true)

    input.movementLifecycle = {
      distance_to_previous_high_atr: [10],
      distance_to_previous_low_atr: [10],
    }
    input.volumeOrderFlow.rel_volume_at_time = [0.5]
    input.volumeOrderFlow.volume_acceleration_3h = [-1]
    input.derivatives.crowd_vs_top_traders = [0]

    assert.equal(calculateDivergenceFlags(input)[squeezeFlag][0], true)
  })

  test(`squeeze_fuel preserves its ${direction} percentile, OI and strict crowd thresholds`, () => {
    assertThresholds(createInput(direction), "squeeze_fuel", [
      ["derivatives", "funding_percentile_90d", direction === "up"
        ? [
            [0.05 - Number.EPSILON, true],
            [0.05, true],
            [0.05 + Number.EPSILON, false],
            [0.95, false],
          ]
        : [
            [0.05, false],
            [0.95 - Number.EPSILON, false],
            [0.95, true],
            [0.95 + Number.EPSILON, true],
          ]],
      ["derivatives", "oi_level_percentile_90d", [
        [0.8 - Number.EPSILON, false],
        [0.8, true],
        [0.8 + Number.EPSILON, true],
      ]],
      ["derivatives", "crowd_vs_top_traders", [
        [-sign * (0.15 + Number.EPSILON), true],
        [-sign * 0.15, false],
        [-sign * (0.15 - Number.EPSILON), false],
        [0, false],
        [sign * 0.16, false],
      ]],
    ])
  })

  test(`squeeze_fuel requires the ${direction} funding sign but not price levels, flow or OI growth`, () => {
    const input = createInput(direction)
    delete input.movementLifecycle
    delete input.volumeOrderFlow
    delete input.derivatives.funding_rate
    delete input.derivatives.oi_change_4h

    assert.equal(calculateDivergenceFlags(input).squeeze_fuel[0], null)

    for (const fundingRate of [-0.001, 0, 0.001]) {
      input.derivatives.funding_rate = [fundingRate]
      input.derivatives.oi_change_4h = [-0.01]
      assert.equal(calculateDivergenceFlags(input).squeeze_fuel[0], Math.sign(fundingRate) === -sign)
    }
  })

  test(`${direction} flags return null for each unavailable prerequisite and preserve alignment`, () => {
    for (const [flag, required] of [
      [rangeFlag, [
        ["movementLifecycle", distanceMetric],
        ["volumeOrderFlow", "rel_volume_at_time"],
        ["volumeOrderFlow", "vd_net_4h_over_volume"],
      ]],
      [squeezeFlag, [
        ["derivatives", "funding_rate"],
        ["derivatives", "funding_percentile_90d"],
        ["derivatives", "oi_level_percentile_90d"],
        ["derivatives", "oi_change_4h"],
        ["volumeOrderFlow", "vd_net_4h_over_volume"],
      ]],
      ["squeeze_fuel", [
        ["derivatives", "funding_rate"],
        ["derivatives", "funding_percentile_90d"],
        ["derivatives", "oi_level_percentile_90d"],
        ["derivatives", "crowd_vs_top_traders"],
      ]],
    ]) {
      for (const [group, metric] of required) {
        for (const series of [undefined, null, [], [null], [undefined], [NaN], [Infinity], [-Infinity], ["0.1"]]) {
          const input = createInput(direction)
          input[group][metric] = series
          assert.deepEqual(
            calculateDivergenceFlags(input)[flag],
            [null],
            `${flag}: unavailable ${group}.${metric} = ${series}`,
          )
        }

        const input = createInput(direction)
        input.close = [100, 100, 100]
        for (const seriesByName of [input.movementLifecycle, input.volumeOrderFlow, input.derivatives]) {
          Object.values(seriesByName).forEach(series => series.push(series[0], series[0]))
        }
        input[group][metric][0] = null
        input[group][metric][2] = null
        assert.deepEqual(
          calculateDivergenceFlags(input)[flag],
          [null, true, null],
          `${flag}: aligned warmup and gap for ${group}.${metric}`,
        )
      }
    }
  })
}
