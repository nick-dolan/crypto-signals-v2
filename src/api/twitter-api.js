import "dotenv/config"

export async function fetchTweetPage (query, cursor = "") {
  const url = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search")

  url.searchParams.set("query", query)
  url.searchParams.set("queryType", "Latest")
  url.searchParams.set("cursor", cursor)

  const response = await fetch(url.toString(), {
    headers: { "X-API-Key": process.env.TWITTERAPI_IO_KEY || "" },
  })

  if (!response.ok) {
    throw new Error(`Twitter API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}
