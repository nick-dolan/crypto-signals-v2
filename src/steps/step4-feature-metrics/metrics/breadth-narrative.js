export function calculateBreadthNarrativeMetrics ({ categoryContext }) {
  return {
    category_momentum_4h: categoryContext.momentum4h,
    category_breadth: categoryContext.breadth,
    coin_leads_category: categoryContext.coinLeadsCategory,
  }
}
