import { sleep } from "radash"

import { fetchTweetPage } from "../../api/twitter-api.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import {
  isArray,
  isError,
  isFunction,
  isNaN,
  isObject,
  isSafeInteger,
  isString,
} from "../../helpers/utils.typed.js"

function getDefaultReferenceTimestamp () {
  const pipelineStartedAt = Number(process.env.PIPELINE_STARTED_AT)

  return isSafeInteger(pipelineStartedAt) && pipelineStartedAt > 0
    ? pipelineStartedAt
    : Math.floor(Date.now() / 1_000)
}

function getErrorMessage (error) {
  return isError(error) ? error.message : String(error)
}

function getCount (value) {
  return isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeTweet (tweet, referenceTimestamp) {
  if (!isObject(tweet) || !isString(tweet.createdAt)) {
    return null
  }

  const createdAtMilliseconds = Date.parse(tweet.createdAt)
  const referenceMilliseconds = referenceTimestamp * 1_000

  if (
    isNaN(createdAtMilliseconds)
    || createdAtMilliseconds < referenceMilliseconds - 24 * 60 * 60 * 1_000
    || createdAtMilliseconds > referenceMilliseconds
  ) {
    return null
  }

  const author = isObject(tweet.author) ? tweet.author : {}

  return {
    id: isString(tweet.id) && tweet.id ? tweet.id : null,
    text: isString(tweet.text) ? tweet.text : "",
    createdAt: new Date(createdAtMilliseconds).toISOString(),
    hoursAgo: Math.round(
      (referenceMilliseconds - createdAtMilliseconds) / 3_600_000 * 10,
    ) / 10,
    likeCount: getCount(tweet.likeCount),
    retweetCount: getCount(tweet.retweetCount),
    viewCount: getCount(tweet.viewCount),
    authorUsername: isString(author.userName) && author.userName
      ? author.userName
      : null,
    authorFollowers: getCount(author.followers),
  }
}

function selectRecentTweets (page, pageNumber, referenceTimestamp) {
  if (!isObject(page) || !isArray(page.tweets)) {
    throw new Error(`Twitter page ${pageNumber} response does not contain a tweets array`)
  }

  return page.tweets
    .map(tweet => normalizeTweet(tweet, referenceTimestamp))
    .filter(tweet => tweet !== null)
}

function mergeTweets (...groups) {
  const tweetIds = new Set()

  return groups
    .flat()
    .filter((tweet) => {
      if (!tweet.id || !tweetIds.has(tweet.id)) {
        if (tweet.id) {
          tweetIds.add(tweet.id)
        }

        return true
      }

      return false
    })
    .sort((first, second) => (
      second.createdAt.localeCompare(first.createdAt)
      || (first.id ?? "").localeCompare(second.id ?? "")
    ))
}

async function fetchRecentTweets (
  symbol,
  referenceTimestamp,
  fetchPage,
  wait,
) {
  const query = `$${symbol.toUpperCase()}`
  const firstPage = await fetchPage(query)
  const firstPageTweets = selectRecentTweets(firstPage, 1, referenceTimestamp)
  const cursor = isString(firstPage.next_cursor)
    ? firstPage.next_cursor.trim()
    : ""

  if (!cursor || firstPageTweets.length === 0) {
    return {
      query,
      fetchedPageCount: 1,
      tweets: firstPageTweets,
    }
  }

  await wait(300)

  const secondPage = await fetchPage(query, cursor)
  const secondPageTweets = selectRecentTweets(secondPage, 2, referenceTimestamp)

  return {
    query,
    fetchedPageCount: 2,
    tweets: mergeTweets(firstPageTweets, secondPageTweets),
  }
}

function validateInput (input) {
  if (!isObject(input) || !isArray(input.topCandidates)) {
    throw new Error("Step 8 top candidates are required")
  }

  getRequiredString(input.asOf, "Step 8 asOf")

  const symbols = new Set()

  return input.topCandidates.map((candidate, index) => {
    const symbol = getRequiredString(
      candidate?.symbol,
      `Step 8 top candidate ${index} symbol`,
    ).toUpperCase()

    if (symbols.has(symbol)) {
      throw new Error(`Step 8 top candidates contain duplicate symbol ${symbol}`)
    }

    symbols.add(symbol)
    return { candidate, symbol }
  })
}

async function enrichCandidate (
  { candidate, symbol },
  referenceTimestamp,
  fetchPage,
  wait,
) {
  const query = `$${symbol}`

  try {
    const result = await fetchRecentTweets(
      symbol,
      referenceTimestamp,
      fetchPage,
      wait,
    )

    return {
      ...candidate,
      twitter: {
        query: result.query,
        status: result.tweets.length > 0 ? "available" : "empty",
        error: null,
        fetchedPageCount: result.fetchedPageCount,
        recentTweetCount: result.tweets.length,
        tweets: result.tweets,
      },
    }
  } catch (error) {
    return {
      ...candidate,
      twitter: {
        query,
        status: "failed",
        error: getErrorMessage(error),
        fetchedPageCount: null,
        recentTweetCount: null,
        tweets: [],
      },
    }
  }
}

export async function enrichTopCandidatesWithTwitter (
  input,
  {
    fetchPage = fetchTweetPage,
    referenceTimestamp = getDefaultReferenceTimestamp(),
    wait = sleep,
  } = {},
) {
  if (!isFunction(fetchPage) || !isFunction(wait)) {
    throw new Error("Twitter fetcher and wait must be functions")
  }

  if (!isSafeInteger(referenceTimestamp) || referenceTimestamp <= 0) {
    throw new Error("Twitter referenceTimestamp must be a positive Unix timestamp")
  }

  const candidates = validateInput(input)
  const topCandidates = []

  for (const [index, candidate] of candidates.entries()) {
    topCandidates.push(await enrichCandidate(
      candidate,
      referenceTimestamp,
      fetchPage,
      wait,
    ))

    if (index < candidates.length - 1) {
      await wait(300)
    }
  }

  return {
    ...input,
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    twitterEnrichment: {
      source: "twitterapi.io",
      asOf: new Date(referenceTimestamp * 1_000).toISOString(),
      from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
      lookbackHours: 24,
      maxPagesPerCandidate: 2,
    },
    topCandidates,
  }
}
