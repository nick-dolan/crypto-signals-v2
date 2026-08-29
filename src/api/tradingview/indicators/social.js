import { defineIndicator } from "./definition.js"

function defineSocialIndicator (definition) {
  return defineIndicator("social", definition)
}

export const SOCIAL_INDICATOR_DEFINITIONS = Object.freeze([
  defineSocialIndicator({
    key: "altRank",
    id: "STD;CryptoFund_alt_rank",
    version: "7.0",
    name: "AltRank",
    fields: {
      rank: "AltRank",
    },
  }),
  defineSocialIndicator({
    key: "galaxyScore",
    id: "STD;CryptoFund_galaxy_score",
    version: "7.0",
    name: "Galaxy score",
    fields: {
      score: "Galaxy_score",
    },
  }),
  defineSocialIndicator({
    key: "socialDominance",
    id: "STD;CryptoFund_social_dominance",
    version: "7.0",
    name: "Social dominance %",
    fields: {
      percent: "Social_dominance_",
    },
  }),
  defineSocialIndicator({
    key: "sentiment",
    id: "STD;CryptoFund_sentiment",
    version: "7.0",
    name: "Sentiment %",
    fields: {
      percent: "Sentiment_",
    },
  }),
  defineSocialIndicator({
    key: "interactions",
    id: "STD;CryptoFund_interactions",
    version: "7.0",
    name: "Interactions",
    fields: {
      value: "Interactions",
    },
  }),
  defineSocialIndicator({
    key: "activeContributors",
    id: "STD;CryptoFund_contributors_active",
    version: "7.0",
    name: "Active contributors",
    fields: {
      value: "Active_contributors",
    },
  }),
  defineSocialIndicator({
    key: "createdContributors",
    id: "STD;CryptoFund_contributors_created",
    version: "7.0",
    name: "Created contributors",
    fields: {
      value: "Created_contributors",
    },
  }),
  defineSocialIndicator({
    key: "activePosts",
    id: "STD;CryptoFund_posts_active",
    version: "7.0",
    name: "Active posts",
    fields: {
      value: "Active_posts",
    },
  }),
  defineSocialIndicator({
    key: "createdPosts",
    id: "STD;CryptoFund_posts_created",
    version: "7.0",
    name: "Created posts",
    fields: {
      value: "Created_posts",
    },
  }),
])
