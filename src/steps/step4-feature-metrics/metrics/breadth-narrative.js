import { simpleReturns } from "../../../scripts/returns.js"

export function calculateBreadthNarrativeMetrics ({
  universeBreadth4h,
  segmentRotation4h,
  stableCap,
  categoryContext,
}) {
  return {
    breadth_pct_universe_up_4h: universeBreadth4h,
    segment_rotation_4h: segmentRotation4h,
    category_momentum_4h: categoryContext.momentum4h,
    category_breadth: categoryContext.breadth,
    coin_leads_category: categoryContext.coinLeadsCategory,
    stablecap_change_24h: simpleReturns(stableCap, 24),
  }
}
