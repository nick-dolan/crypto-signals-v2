import { combineSeries, difference, mapSeries } from "../../../scripts/series.js"
import { rollingMean, rollingSum, rollingZScore } from "../../../scripts/rolling-statistics.js"
import { simpleReturns } from "../../../scripts/returns.js"

export function calculateSocialMetrics ({
  close,
  socialDominance,
  interactions,
  activeContributors,
  createdPosts,
  activePosts,
}) {
  const interactionsAcceleration3h = simpleReturns(
    rollingSum(interactions, 3),
    3,
  )
  const absolutePriceReturn3h = mapSeries(
    simpleReturns(close, 3),
    value => Math.abs(value),
  )

  return {
    social_dominance_z_30d: rollingZScore(socialDominance, 720),
    interactions_z_30d: rollingZScore(
      mapSeries(interactions, value => Math.log1p(value)),
      720,
    ),
    interactions_acceleration_3h: interactionsAcceleration3h,
    interactions_per_contributor_z: rollingZScore(combineSeries(
      [interactions, activeContributors],
      ([interactionCount, contributorCount]) => Math.log1p(
        interactionCount / (contributorCount === 0 ? 1 : contributorCount),
      ),
    ), 720),
    created_posts_per_active_contributor: combineSeries(
      [createdPosts, activeContributors],
      ([postCount, contributorCount]) => (
        postCount / (contributorCount === 0 ? 1 : contributorCount)
      ),
    ),
    social_minus_price_z_3h: combineSeries(
      [
        rollingZScore(interactionsAcceleration3h, 720),
        rollingZScore(absolutePriceReturn3h, 720),
      ],
      ([interactionsZScore, priceZScore]) => interactionsZScore - priceZScore,
    ),
    active_posts_z_30d: rollingZScore(
      mapSeries(activePosts, value => Math.log1p(value)),
      720,
    ),
    active_posts_change_6h: difference(
      mapSeries(rollingMean(activePosts, 6), value => Math.log1p(value)),
      6,
    ),
  }
}
