import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { createCoinResearchTools } from "../src/steps/step1.1-coin-descriptions/create-coin-research-tools.js"

beforeEach((context) => {
  const fetch = context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network request"))
  context.after(() => assert.equal(fetch.mock.callCount(), 0))
})

function success (result) {
  assert.equal(result.resultType, "success")
  assert.deepEqual(Object.keys(result).sort(), ["resultType", "textResultForLlm"])
  return JSON.parse(result.textResultForLlm)
}

function failure (result, pattern = /.+/) {
  assert.equal(result.resultType, "failure")
  assert.match(result.error, pattern)
  assert.deepEqual(JSON.parse(result.textResultForLlm), { error: result.error })
  assert.doesNotMatch(JSON.stringify(result), /private-response|private-key/)
}

function extracted (url, rawContent = "Coin documentation") {
  return { results: [{ url, raw_content: rawContent }], failed_results: [] }
}

test("research factory exposes two eager, preapproved official SDK tools with strict schemas", () => {
  const { tools, selectSources } = createCoinResearchTools()

  assert.deepEqual(tools.map(tool => tool.name), ["search_coin_sources", "read_coin_source"])

  for (const [index, key] of ["query", "url"].entries()) {
    const tool = tools[index]
    assert.equal(tool.skipPermission, true)
    assert.equal(tool.defer, "never")
    assert.equal(tool.parameters.type, "object")
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.required, [key])
    assert.deepEqual(Object.keys(tool.parameters.properties), [key])
    assert.equal(tool.parameters.properties[key].type, "string")
    assert.equal(tool.parameters.properties[key].minLength, 1)
  }

  assert.throws(() => selectSources(["source-1"]), /не был успешно прочитан/)
})

test("search sends only fixed basic options and exposes at most five bounded result snippets", async (context) => {
  const response = {
    answer: "private-response https://answer.example/coin",
    images: ["https://images.example/coin"],
    results: [
      null,
      { url: "file:///etc/passwd" },
      {
        title: "t".repeat(250),
        url: " HTTPS://EXAMPLE.COM:443/coin#overview ",
        content: "c".repeat(2_100),
        raw_content: "private-response https://raw.example/coin",
        sourceId: "source-1",
        checkedAt: "2099-01-01T00:00:00.000Z",
        score: 0.99,
      },
      { title: 123, url: "http://news.example:80", content: {} },
      ...Array.from({ length: 4 }, (_, index) => ({
        title: ` Page ${index} `,
        url: `https://pages.example/${index}`,
        content: " See https://linked.example/coin ",
      })),
    ],
  }
  const original = structuredClone(response)
  const request = context.mock.fn(async () => response)
  const { tools: [search, read], selectSources } = createCoinResearchTools({ request })
  const result = success(await search.handler({ query: "  Coin official docs  " }))

  assert.deepEqual(request.mock.calls[0].arguments, ["/search", {
    query: "Coin official docs",
    search_depth: "basic",
    topic: "general",
    max_results: 5,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: false,
  }])
  assert.deepEqual(result, {
    results: [
      { title: "t".repeat(200), url: "https://example.com/coin", content: "c".repeat(2_000) },
      { title: "", url: "http://news.example/", content: "" },
      ...Array.from({ length: 3 }, (_, index) => ({
        title: `Page ${index}`,
        url: `https://pages.example/${index}`,
        content: "See https://linked.example/coin",
      })),
    ],
  })
  assert.deepEqual(response, original)
  assert.throws(() => selectSources(["source-1"]))
  assert.throws(() => selectSources(["https://example.com/coin"]))

  for (const url of [
    "https://answer.example/coin", "https://images.example/coin", "https://raw.example/coin",
    "https://linked.example/coin", "https://pages.example/3", "https://made-up.example/coin",
  ]) {
    failure(await read.handler({ url }), /seedUrls|результатов поиска/)
  }

  assert.equal(request.mock.callCount(), 1)
})

test("invalid arguments never spend either budget or allow overriding paid request options", async (context) => {
  const seedUrls = Array.from({ length: 2 }, (_, index) => `https://example.com/${index}`)
  const request = context.mock.fn(async (endpoint, body) => (
    endpoint === "/search" ? { results: [] } : extracted(body.urls[0])
  ))
  const { tools } = createCoinResearchTools({ seedUrls, request })

  for (const [index, key] of ["query", "url"].entries()) {
    for (const args of [
      undefined, null, false, 42, "text", [], {}, { wrong: "text" },
      ...[undefined, null, 42, [], {}, "", " \n\t "].map(value => ({ [key]: value })),
      { [key]: index === 0 ? "Coin" : seedUrls[0], extra: true },
      { [key]: index === 0 ? "Coin" : seedUrls[0], search_depth: "advanced" },
      Object.create({ [key]: index === 0 ? "Coin" : seedUrls[0] }),
    ]) {
      failure(await tools[index].handler(args), /непустой строкой/)
    }
  }

  assert.equal(request.mock.callCount(), 0)

  for (const url of seedUrls) {
    success(await tools[0].handler({ query: "Coin" }))
    success(await tools[1].handler({ url }))
  }

  failure(await tools[0].handler({ query: "Coin" }), /не более 2/)
  assert.equal(request.mock.callCount(), 4)
})

test("unsafe seeds and search URLs are ignored without breaking valid research", async (context) => {
  const unsafeUrls = [
    undefined, null, 42, {}, [], "", " ", "https://", "/relative", "//public.example/coin",
    "file:///etc/passwd", "data:text/plain,coin", "javascript:alert(1)", "ftp://example.com/coin",
    "http://localhost", "https://LOCALHOST.", "https://sub.localhost./coin",
    "https://coin", "https://coin.", "https://host.local", "https://host.LOCAL./",
    "https://sub.host.internal/coin", "https://LOCAL.", "https://INTERNAL.",
    "http://127.0.0.1", "http://192.168.1.1", "http://10.0.0.1", "https://8.8.8.8",
    "http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1",
    "http://127.0.0.1.", "http://%31%32%37.0.0.1", "http://[::1]",
    "http://[2001:4860:4860::8888]", "http://[::ffff:127.0.0.1]",
    "https://user@example.com", "https://:pass@example.com", "https://example.com@localhost",
    "https://user:pass@public.example",
  ]
  const request = context.mock.fn(async (endpoint, body) => (
    endpoint === "/search"
      ? { results: [...unsafeUrls, "https://public.example/coin"].map(url => ({ url })) }
      : extracted(body.urls[0])
  ))
  const { tools: [search, read], selectSources } = createCoinResearchTools({
    seedUrls: [...unsafeUrls, "https://public.example/coin"],
    request,
  })

  assert.deepEqual(success(await search.handler({ query: "Coin" })), {
    results: [{ title: "", url: "https://public.example/coin", content: "" }],
  })

  for (const url of unsafeUrls) {
    failure(await read.handler({ url }))
  }

  assert.equal(request.mock.callCount(), 1)
  assert.throws(() => selectSources(["source-1"]))
  const source = success(await read.handler({ url: "https://public.example/coin" }))
  assert.equal(source.sourceId, "source-1")
  assert.equal(request.mock.callCount(), 2)
})

test("normalized seed reads coalesce, cache bounded text, timestamp after response and isolate references", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-25T12:00:00.000Z") })
  const pending = Promise.withResolvers()
  const request = context.mock.fn(() => pending.promise)
  const seedUrls = [" HTTPS://EXAMPLE.COM.:443/a/../coin#seed "]
  const { tools: [, read], selectSources } = createCoinResearchTools({ seedUrls, request })
  seedUrls.push("https://example.com/unapproved")
  failure(await read.handler({ url: seedUrls[1] }))
  const first = read.handler({ url: "https://example.com/coin#one" })
  const second = read.handler({ url: "https://EXAMPLE.COM:443/coin#two" })

  assert.equal(request.mock.callCount(), 1)
  assert.deepEqual(request.mock.calls[0].arguments, ["/extract", {
    urls: ["https://example.com/coin"],
    extract_depth: "basic",
    format: "text",
    include_images: false,
    timeout: 20,
  }])
  assert.throws(() => selectSources(["source-1"]))
  context.mock.timers.tick(1_234)
  const response = extracted("https://EXAMPLE.COM.:443/coin#extracted", ` \n${"x".repeat(17_000)} `)
  response.results[0].checkedAt = "2099-01-01T00:00:00.000Z"
  response.results[0].sourceId = "source-999"
  pending.resolve(response)
  const [firstResult, secondResult] = await Promise.all([first, second])
  const source = success(firstResult)

  assert.notStrictEqual(firstResult, secondResult)
  assert.deepEqual(success(secondResult), source)
  assert.deepEqual(source, {
    sourceId: "source-1",
    url: "https://example.com/coin",
    checkedAt: "2026-09-25T12:00:01.234Z",
    content: "x".repeat(16_000),
  })
  context.mock.timers.tick(10_000)
  response.results[0].raw_content = "Modified response"
  response.results[0].url = "https://other.example/coin"
  firstResult.textResultForLlm = "Modified envelope"
  source.content = "Modified decoded content"
  assert.deepEqual(success(await read.handler({ url: "https://example.com/coin#cached" })), success(secondResult))

  const sourceIds = ["source-1"]
  const selected = selectSources(sourceIds)
  assert.deepEqual(selected, [{ url: "https://example.com/coin", checkedAt: "2026-09-25T12:00:01.234Z" }])
  sourceIds[0] = "source-999"
  selected[0].url = "https://made-up.example/coin"
  selected[0].checkedAt = "2099-01-01T00:00:00.000Z"
  selected.push({ content: "not a source" })
  assert.deepEqual(selectSources(["source-1"]), [{
    url: "https://example.com/coin",
    checkedAt: "2026-09-25T12:00:01.234Z",
  }])
  assert.throws(() => selectSources(["source-999"]))
  assert.equal(request.mock.callCount(), 1)
})

test("search reserves exactly two requests before await and never refunds failures", async (context) => {
  const pending = []
  const request = context.mock.fn(() => {
    const operation = Promise.withResolvers()
    pending.push(operation)
    return operation.promise
  })
  const { tools: [search], selectSources } = createCoinResearchTools({ request })
  const calls = Array.from({ length: 8 }, () => search.handler({ query: "Coin" }))

  assert.equal(request.mock.callCount(), 2)
  for (const result of await Promise.all(calls.slice(2))) {
    failure(result, /не более 2 запросов поиска/)
  }

  pending[0].resolve({ results: null, error: "private-response private-key" })
  pending[1].reject(new Error("Tavily /search HTTP 429"))
  const results = await Promise.all(calls.slice(0, 2))
  failure(results[0], /некорректный ответ/)
  failure(results[1], /Tavily \/search HTTP 429/)
  failure(await search.handler({ query: "Retry Coin" }), /не более 2/)
  assert.throws(() => selectSources(["source-1"]))
  assert.equal(request.mock.callCount(), 2)
})

test("extract reserves exactly two attempts before await, including failed responses", async (context) => {
  const pending = []
  const seedUrls = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`)
  const request = context.mock.fn(() => {
    const operation = Promise.withResolvers()
    pending.push(operation)
    return operation.promise
  })
  const { tools: [, read], selectSources } = createCoinResearchTools({ seedUrls, request })
  const calls = seedUrls.map(url => read.handler({ url }))

  assert.equal(request.mock.callCount(), 2)
  for (const result of await Promise.all(calls.slice(2))) {
    failure(result, /не более 2 попыток extract/)
  }

  assert.throws(() => selectSources(["source-1"]))
  pending[0].resolve(extracted(seedUrls[0]))
  pending[1].resolve({ results: [], failed_results: [{ url: seedUrls[1], error: "private-response private-key" }] })
  const results = await Promise.all(calls.slice(0, 2))
  const source = success(results[0])
  failure(results[1], /не смог прочитать/)
  assert.deepEqual(selectSources([source.sourceId]), [{ url: source.url, checkedAt: source.checkedAt }])
  assert.throws(() => selectSources(["source-2"]))
  failure(await read.handler({ url: seedUrls[1] }), /не более 2/)
  assert.deepEqual(success(await read.handler({ url: `${seedUrls[0]}#cached` })), source)
  assert.equal(request.mock.callCount(), 2)
})

test("concurrent failures coalesce but are not cached, and retries share the original extract budget", async (context) => {
  const pending = []
  const request = context.mock.fn(() => {
    const operation = Promise.withResolvers()
    pending.push(operation)
    return operation.promise
  })
  const { tools: [, read], selectSources } = createCoinResearchTools({
    seedUrls: ["https://example.com/coin", "https://example.com/other"],
    request,
  })
  const first = read.handler({ url: "https://example.com/coin" })
  const duplicate = read.handler({ url: "https://example.com/coin#duplicate" })
  assert.equal(request.mock.callCount(), 1)
  pending[0].reject(new Error("Tavily /extract transport failure"))

  for (const result of await Promise.all([first, duplicate])) {
    failure(result, /transport failure/)
  }

  assert.throws(() => selectSources(["source-1"]))
  const retry = read.handler({ url: "https://example.com/coin" })
  const retryDuplicate = read.handler({ url: "https://example.com/coin#duplicate" })
  assert.equal(request.mock.callCount(), 2)
  pending[1].resolve(extracted("https://example.com/coin"))
  const source = success(await retry)
  assert.equal(source.sourceId, "source-1")
  assert.deepEqual(success(await retryDuplicate), source)
  assert.deepEqual(success(await read.handler({ url: "https://example.com/coin" })), source)
  failure(await read.handler({ url: "https://example.com/other" }), /не более 2/)
  assert.equal(request.mock.callCount(), 2)
})

for (const [index, args] of [[0, { query: "Coin" }], [1, { url: "https://example.com/coin" }]]) {
  test(`tool ${index} counts synchronous requester errors and safely handles non-Error rejections`, async (context) => {
    const request = context.mock.fn(() => {
      throw { message: "private-response private-key" }
    })
    const { tools, selectSources } = createCoinResearchTools({ seedUrls: ["https://example.com/coin"], request })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      failure(await tools[index].handler(args), /через Tavily/)
    }

    failure(await tools[index].handler(args), /не более 2/)
    assert.equal(request.mock.callCount(), 2)
    assert.throws(() => selectSources(["source-1"]))
  })
}

for (const [label, response] of [
  ["null", null],
  ["array", []],
  ["primitive", "private-response"],
  ["missing results", {}],
  ["non-array results", { results: {} }],
  ["null results", { results: null }],
  ["error alongside results", { error: "private-response private-key", results: [{ url: "https://example.com/coin" }] }],
]) {
  test(`search rejects malformed responses: ${label}`, async (context) => {
    const request = context.mock.fn(async () => response)
    const { tools: [search, read], selectSources } = createCoinResearchTools({ request })

    failure(await search.handler({ query: "Coin" }), /некорректный ответ/)
    failure(await read.handler({ url: "https://example.com/coin" }), /seedUrls/)
    assert.throws(() => selectSources(["source-1"]))
    assert.equal(request.mock.callCount(), 1)
  })
}

for (const [label, response] of [
  ["null", null],
  ["array", []],
  ["primitive", "private-response"],
  ["missing results", {}],
  ["non-array results", { results: {} }],
  ["null results", { results: null }],
  ["empty results", { results: [] }],
  ["null result", { results: [null] }],
  ["empty result", { results: [{}] }],
  ["missing text", { results: [{ url: "https://example.com/coin" }] }],
  ["wrong text field", { results: [{ url: "https://example.com/coin", content: "private-response" }] }],
  ["empty text", extracted("https://example.com/coin", "")],
  ["whitespace text", extracted("https://example.com/coin", " \n\t ")],
  ["null text", extracted("https://example.com/coin", null)],
  ["numeric text", extracted("https://example.com/coin", 42)],
  ["object text", extracted("https://example.com/coin", { content: "private-response" })],
  ["missing URL", { results: [{ raw_content: "private-response" }] }],
  ["unsafe URL", extracted("file:///etc/passwd", "private-response")],
  ["different host", extracted("https://other.example/coin", "private-response")],
  ["different path", extracted("https://example.com/other", "private-response")],
  ["different query", extracted("https://example.com/coin?page=2", "private-response")],
  ["different scheme", extracted("http://example.com/coin", "private-response")],
  ["duplicate results", { results: [...extracted("https://example.com/coin").results, ...extracted("https://example.com/coin").results] }],
  ["top-level error", { ...extracted("https://example.com/coin"), error: "private-response private-key" }],
  ["result error", { results: [{ url: "https://example.com/coin", raw_content: "private-response", error: "private-key" }] }],
  ["null failed_results", { ...extracted("https://example.com/coin"), failed_results: null }],
  ["object failed_results", { ...extracted("https://example.com/coin"), failed_results: {} }],
  ["string failed_results", { ...extracted("https://example.com/coin"), failed_results: "private-response" }],
  ["failed requested URL", { ...extracted("https://example.com/coin"), failed_results: [{ url: "https://example.com/coin", error: "private-response private-key" }] }],
  ["unrelated failure", { ...extracted("https://example.com/coin"), failed_results: [{ url: "https://other.example/coin", error: "private-response" }] }],
  ["malformed failure", { ...extracted("https://example.com/coin"), failed_results: [null] }],
]) {
  test(`extract never creates citations for invalid HTTP-200 payloads: ${label}`, async (context) => {
    const request = context.mock.fn(async () => response)
    const { tools: [, read], selectSources } = createCoinResearchTools({ seedUrls: ["https://example.com/coin"], request })

    failure(await read.handler({ url: "https://example.com/coin" }), /Tavily \/extract/)
    assert.throws(() => selectSources(["source-1"]))
    assert.equal(request.mock.callCount(), 1)
    assert.equal(request.mock.calls[0].arguments[0], "/extract")
  })
}

test("selectSources accepts only one to two distinct successful local IDs and preserves requested order", async (context) => {
  const seedUrls = Array.from({ length: 2 }, (_, index) => `https://example.com/${index}`)
  const request = context.mock.fn(async (_endpoint, { urls: [url] }) => ({ results: [{ url, raw_content: "Coin facts" }] }))
  const { tools: [, read], selectSources } = createCoinResearchTools({ seedUrls, request })
  const sources = []

  for (const url of seedUrls) {
    sources.push(success(await read.handler({ url })))
  }

  assert.deepEqual(sources.map(source => source.sourceId), ["source-1", "source-2"])
  assert.deepEqual(selectSources(["source-2", "source-1"]), [sources[1], sources[0]].map(({ url, checkedAt }) => ({ url, checkedAt })))
  assert.deepEqual(selectSources(sources.map(source => source.sourceId)), sources.map(({ url, checkedAt }) => ({ url, checkedAt })))

  for (const sourceIds of [
    undefined, null, false, "source-1", {}, [], [""], [1], [undefined], new Array(1),
    [["source-1"]], [{ sourceId: "source-1" }], ["source-1 "], ["source-0"], ["source-4"],
    ["source-1", "source-1"], ["source-1", "source-999"],
    ["source-1", "source-2", "source-3"],
    [seedUrls[0]], [{ url: seedUrls[0], checkedAt: sources[0].checkedAt }],
  ]) {
    assert.throws(() => selectSources(sourceIds))
  }

  assert.equal(request.mock.callCount(), 2)
})

test("concurrent successful reads get unique IDs in completion order, not request or agent order", async (context) => {
  const pending = []
  const seedUrls = ["https://example.com/first", "https://example.com/second"]
  const request = context.mock.fn(() => {
    const operation = Promise.withResolvers()
    pending.push(operation)
    return operation.promise
  })
  const { tools: [, read], selectSources } = createCoinResearchTools({ seedUrls, request })
  const calls = seedUrls.map(url => read.handler({ url }))

  for (const [completionIndex, requestIndex] of [1, 0].entries()) {
    pending[requestIndex].resolve(extracted(seedUrls[requestIndex]))
    const source = success(await calls[requestIndex])
    assert.equal(source.sourceId, `source-${completionIndex + 1}`)
    assert.deepEqual(selectSources([source.sourceId]), [{ url: seedUrls[requestIndex], checkedAt: source.checkedAt }])
  }

  assert.equal(request.mock.callCount(), 2)
  assert.deepEqual(selectSources(["source-1", "source-2"]).map(source => source.url), [seedUrls[1], seedUrls[0]])
})

test("factories isolate allowlists, sources, caches and paid budgets for different coins", async (context) => {
  const firstRequest = context.mock.fn(async (endpoint, body) => (
    endpoint === "/search"
      ? { results: [{ url: "https://example.com/discovered" }] }
      : extracted(body.urls[0], "First coin")
  ))
  const secondRequest = context.mock.fn(async (endpoint, body) => (
    endpoint === "/search" ? { results: [] } : extracted(body.urls[0], "Second coin")
  ))
  const first = createCoinResearchTools({ seedUrls: ["https://example.com/shared"], request: firstRequest })
  const second = createCoinResearchTools({ seedUrls: ["https://example.com/shared"], request: secondRequest })

  success(await first.tools[0].handler({ query: "First coin" }))
  assert.throws(() => first.selectSources(["source-1"]))
  const discovered = success(await first.tools[1].handler({ url: "https://example.com/discovered" }))
  assert.equal(discovered.sourceId, "source-1")
  assert.throws(() => second.selectSources(["source-1"]))
  failure(await second.tools[1].handler({ url: discovered.url }), /seedUrls/)
  assert.equal(secondRequest.mock.callCount(), 0)

  const sharedFirst = success(await first.tools[1].handler({ url: "https://example.com/shared" }))
  const sharedSecond = success(await second.tools[1].handler({ url: "https://example.com/shared" }))
  assert.equal(sharedFirst.sourceId, "source-2")
  assert.equal(sharedFirst.content, "First coin")
  assert.equal(sharedSecond.sourceId, "source-1")
  assert.equal(sharedSecond.content, "Second coin")
  assert.equal(secondRequest.mock.callCount(), 1)
  assert.throws(() => second.selectSources(["source-2"]))

  success(await first.tools[0].handler({ query: "First coin" }))
  failure(await first.tools[0].handler({ query: "First coin" }), /не более 2/)

  for (let index = 0; index < 2; index += 1) {
    success(await second.tools[0].handler({ query: "Second coin" }))
  }

  failure(await second.tools[0].handler({ query: "Second coin" }), /не более 2/)
  assert.equal(firstRequest.mock.callCount(), 4)
  assert.equal(secondRequest.mock.callCount(), 3)
})
