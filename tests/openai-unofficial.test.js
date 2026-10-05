import assert from "node:assert/strict"

import fs from "node:fs/promises"

import test from "node:test"
import { pathToFileURL } from "node:url"

function createToken (generation = 1) {
  const payload = Buffer.from(JSON.stringify({
    generation,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  })).toString("base64url")

  return `fixture.${payload}.signature`
}

function createSession (overrides = {}) {
  return {
    token: createToken(),
    refreshToken: "refresh-before",
    accountId: "account-test",
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  }
}

async function createClient (context, session = createSession()) {
  await fs.mkdir(new URL("../tmp/", import.meta.url), { recursive: true })
  const directory = await fs.mkdtemp(new URL("../tmp/openai-unofficial-test-", import.meta.url))
  const root = pathToFileURL(`${directory}/`)
  const apiUrl = new URL("src/api/openai-unofficial/", root)
  const tokenUrl = new URL(".openai-token.json", root)

  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  context.mock.method(console, "log", () => {})

  // Relocate the real client to isolate its credential file and module cache from the user's login.
  await fs.cp(new URL("../src/api/openai-unofficial/", import.meta.url), apiUrl, { recursive: true })
  await fs.mkdir(new URL("src/helpers/", root), { recursive: true })
  await fs.copyFile(
    new URL("../src/helpers/utils.typed.js", import.meta.url),
    new URL("src/helpers/utils.typed.js", root),
  )

  if (session) {
    await fs.writeFile(tokenUrl, JSON.stringify(session), { mode: 0o600 })
  }

  return {
    root,
    apiUrl,
    tokenUrl,
    auth: await import(new URL("auth.js", apiUrl)),
    chat: await import(new URL("chat.js", apiUrl)),
  }
}

function jsonResponse (data, status = 200) {
  return new Response(JSON.stringify(data), { status })
}

function completedResponse (text = "answer", type = "response.completed") {
  return `data: ${JSON.stringify({
    type,
    response: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    },
  })}\n\n`
}

test("device login polls approval, exchanges its verifier, and privately persists a reusable session", async (context) => {
  const client = await createClient(context, null)
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const waiting = Promise.withResolvers()
  let polls = 0

  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, "POST")
    assert.ok(options.signal instanceof AbortSignal)

    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      assert.deepEqual(JSON.parse(options.body), { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" })
      return jsonResponse({ device_auth_id: "device-test", user_code: "CODE-TEST", interval: "5" })
    }

    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      assert.deepEqual(JSON.parse(options.body), { device_auth_id: "device-test", user_code: "CODE-TEST" })
      polls += 1
      if (polls === 1) {
        return new Response(new ReadableStream({
          cancel () {
            setImmediate(waiting.resolve)
          },
        }), { status: 403 })
      }
      return jsonResponse({ authorization_code: "approved-code", code_verifier: "approved-verifier" })
    }

    assert.equal(url, "https://auth.openai.com/oauth/token")
    assert.equal(new Headers(options.headers).get("content-type"), "application/x-www-form-urlencoded")
    assert.deepEqual(Object.fromEntries(options.body), {
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "approved-code",
      code_verifier: "approved-verifier",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    })
    return jsonResponse({ access_token: createToken(), refresh_token: "refresh-before", expires_in: 3600 })
  })

  const pending = client.auth.getUnofficialOpenAISession()
  await waiting.promise
  context.mock.timers.tick(5000)
  const session = await pending

  assert.equal(session.token, createToken())
  assert.equal(session.accountId, "account-test")
  assert.ok(session.expiresAt > Date.now() + 3_500_000)
  assert.deepEqual(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")), session)
  assert.equal((await fs.stat(client.tokenUrl)).mode & 0o777, 0o600)
  assert.ok(console.log.mock.calls.some(call => call.arguments.join(" ").includes("CODE-TEST")))
  assert.equal(globalThis.fetch.mock.callCount(), 4)

  const reloaded = await import(new URL("auth.js?reload", client.apiUrl))
  assert.deepEqual(await reloaded.getUnofficialOpenAISession(), session)
  assert.equal(globalThis.fetch.mock.callCount(), 4)
})

test("parallel refreshes share one exchange and preserve rotated refresh tokens across later calls", async (context) => {
  const previous = createSession({ expiresAt: Date.now() - 1000 })
  const client = await createClient(context, previous)
  let exchanges = 0

  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://auth.openai.com/oauth/token")
    assert.equal(options.body.get("grant_type"), "refresh_token")
    assert.equal(options.body.get("refresh_token"), exchanges === 0 ? "refresh-before" : "refresh-after")
    exchanges += 1

    return jsonResponse({
      access_token: createToken(exchanges + 1),
      ...(exchanges === 1 ? { refresh_token: "refresh-after" } : {}),
      expires_in: 3600,
    })
  })

  const sessions = await Promise.all(Array.from({ length: 4 }, () => client.auth.getUnofficialOpenAISession()))
  assert.equal(exchanges, 1)
  assert.ok(sessions.every(session => session.token === createToken(2)))
  assert.equal(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")).refreshToken, "refresh-after")

  const updated = await client.auth.getUnofficialOpenAISession({ rejectedToken: createToken(2) })
  assert.equal(updated.token, createToken(3))
  assert.equal(updated.refreshToken, "refresh-after")
  assert.equal(exchanges, 2)
  assert.deepEqual(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")), updated)
  assert.deepEqual(await client.auth.getUnofficialOpenAISession({ rejectedToken: createToken(2) }), updated)
  assert.equal(exchanges, 2)
})

test("a rejected token refreshes even when another caller is loading a still-fresh session", async (context) => {
  const previous = createSession()
  const client = await createClient(context, previous)
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://auth.openai.com/oauth/token")
    return jsonResponse({ access_token: createToken(2), refresh_token: "refresh-after", expires_in: 3600 })
  })

  const [cached, refreshed] = await Promise.all([
    client.auth.getUnofficialOpenAISession(),
    client.auth.getUnofficialOpenAISession({ rejectedToken: previous.token }),
  ])

  assert.equal(cached.token, previous.token)
  assert.equal(refreshed.token, createToken(2))
  assert.equal(globalThis.fetch.mock.callCount(), 1)
})

test("a failed atomic save preserves the old file and retries persistence without replaying a rotated refresh token", async (context) => {
  const previous = createSession({ expiresAt: Date.now() - 1000 })
  const client = await createClient(context, previous)
  context.mock.method(globalThis, "fetch", async () => jsonResponse({
    access_token: createToken(2), refresh_token: "refresh-after", expires_in: 3600,
  }))
  const rename = context.mock.method(fs, "rename", async () => {
    throw new Error("Disk failure")
  })

  await assert.rejects(client.auth.getUnofficialOpenAISession(), /Disk failure/)
  assert.deepEqual(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")), previous)
  assert.deepEqual((await fs.readdir(client.root)).sort(), [".openai-token.json", "src"])
  rename.mock.restore()

  const saved = await client.auth.getUnofficialOpenAISession()
  assert.equal(saved.token, createToken(2))
  assert.equal(globalThis.fetch.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")), saved)
})

test("a rejected refresh leaves saved credentials intact and exposes a re-login path without leaking the body", async (context) => {
  const previous = createSession({ expiresAt: Date.now() - 1000 })
  const client = await createClient(context, previous)
  context.mock.method(globalThis, "fetch", async () => jsonResponse({
    error: "invalid_grant",
    error_description: previous.refreshToken,
  }, 400))

  await assert.rejects(client.auth.getUnofficialOpenAISession(), (error) => {
    assert.match(error.message, /HTTP 400.*login: true/)
    assert.ok(!error.message.includes(previous.refreshToken))
    return true
  })
  assert.equal(globalThis.fetch.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")), previous)
})

test("malformed saved credentials do not trigger login, while explicit re-login can replace them", async (context) => {
  const client = await createClient(context, null)
  await fs.writeFile(client.tokenUrl, "broken-token-file")
  context.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/usercode")) {
      return jsonResponse({ device_auth_id: "device-test", usercode: "CODE-TEST" })
    }
    if (url.endsWith("/deviceauth/token")) {
      return jsonResponse({ authorization_code: "approved-code", code_verifier: "approved-verifier" })
    }
    return jsonResponse({ access_token: createToken(), refresh_token: "refresh-before", expires_in: 3600 })
  })

  await assert.rejects(client.auth.getUnofficialOpenAISession(), /Invalid OpenAI token file.*login: true/)
  assert.equal(globalThis.fetch.mock.callCount(), 0)
  assert.equal(await fs.readFile(client.tokenUrl, "utf8"), "broken-token-file")

  assert.equal((await client.auth.getUnofficialOpenAISession({ login: true })).accountId, "account-test")
  assert.equal(globalThis.fetch.mock.callCount(), 3)
})

test("Responses requests use subscription auth and decode SSE across CRLF and UTF-8 byte boundaries", async (context) => {
  const client = await createClient(context)
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses")
    const headers = new Headers(options.headers)
    assert.equal(headers.get("authorization"), `Bearer ${createToken()}`)
    assert.equal(headers.get("chatgpt-account-id"), "account-test")
    assert.equal(headers.get("accept"), "text/event-stream")
    assert.equal(headers.get("openai-beta"), "responses=experimental")
    assert.equal(headers.get("session_id"), headers.get("x-client-request-id"))
    assert.deepEqual(JSON.parse(options.body), {
      model: "test-model",
      instructions: "system prompt",
      input: [{ role: "user", content: [{ type: "input_text", text: "user message" }] }],
      reasoning: { effort: "high" },
      stream: true,
      store: false,
    })

    const bytes = new TextEncoder().encode(
      ": keepalive\r\n\r\ndata: {\"type\":\r\ndata: \"response.output_text.delta\",\"delta\":\"Привет\"}\r\n\r\n"
      + completedResponse("Привет мир").replaceAll("\n", "\r\n"),
    )
    return new Response(new ReadableStream({
      start (controller) {
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]))
        }
        controller.close()
      },
    }))
  })

  assert.equal(await client.chat.callUnofficialOpenAI("system prompt", "user message", {
    model: "test-model", reasoningEffort: "high",
  }), "Привет мир")
  assert.equal(globalThis.fetch.mock.callCount(), 1)
})

test("legacy completion events at EOF can finish accumulated deltas without duplicating text", async (context) => {
  const client = await createClient(context)
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).reasoning, undefined)
    return new Response(
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\n\n"
      + "data: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[]}}",
    )
  })

  assert.equal(await client.chat.callUnofficialOpenAI("", "user", {
    model: "test-model", reasoningEffort: null,
  }), "answer")
})

test("concurrent unauthorized calls refresh once, retry with the rotated token, and never use the paid API", async (context) => {
  const client = await createClient(context)
  let refreshes = 0
  let requests = 0

  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://auth.openai.com/oauth/token") {
      refreshes += 1
      assert.equal(options.body.get("refresh_token"), "refresh-before")
      return jsonResponse({ access_token: createToken(2), refresh_token: "refresh-after", expires_in: 3600 })
    }

    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses")
    requests += 1
    const token = new Headers(options.headers).get("authorization")
    return token === `Bearer ${createToken()}`
      ? jsonResponse({}, 401)
      : new Response(completedResponse())
  })

  assert.deepEqual(await Promise.all(Array.from({ length: 2 }, () => (
    client.chat.callUnofficialOpenAI("system", "user", { model: "test-model" })
  ))), ["answer", "answer"])
  assert.equal(refreshes, 1)
  assert.equal(requests, 4)
  assert.equal(JSON.parse(await fs.readFile(client.tokenUrl, "utf8")).refreshToken, "refresh-after")
})

test("quota errors are not retried and provider diagnostics redact credentials", async (context) => {
  const session = createSession()
  const client = await createClient(context, session)
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses")
    return jsonResponse({ error: { message: `Quota reached ${session.token} ${session.refreshToken}` } }, 429)
  })

  await assert.rejects(client.chat.callUnofficialOpenAI("system", "user", { model: "test-model" }), (error) => {
    assert.match(error.message, /HTTP 429.*Quota reached/)
    assert.ok(!error.message.includes(session.token))
    assert.ok(!error.message.includes(session.refreshToken))
    return true
  })
  assert.equal(globalThis.fetch.mock.callCount(), 1)
})

for (const [label, body, expected] of [
  ["provider failure", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Model unavailable\"}}}\n\n", /Model unavailable/],
  ["incomplete response", "data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n", /max_output_tokens/],
  ["failed completion", "data: {\"type\":\"response.done\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"Turn failed\"}}}\n\n", /Turn failed/],
  ["truncated stream", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: [DONE]\n\n", /ended before completion/],
  ["invalid JSON", "data: {broken-json}\n\n", /invalid SSE event/],
  ["empty answer", completedResponse(""), /Empty response/],
]) {
  test(`${label} rejects instead of returning partial or empty text`, async (context) => {
    const client = await createClient(context)
    context.mock.method(globalThis, "fetch", async () => new Response(body))

    await assert.rejects(client.chat.callUnofficialOpenAI("system", "user", { model: "test-model" }), expected)
    assert.equal(globalThis.fetch.mock.callCount(), 1)
  })
}

for (const name of ["AbortError", "TimeoutError"]) {
  test(`body abort preserves ${name} instead of mutating a readonly DOMException`, async (context) => {
    const client = await createClient(context)
    const failure = new DOMException("Body interrupted", name)
    context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      start (controller) {
        controller.error(failure)
      },
    })))

    await assert.rejects(
      client.chat.callUnofficialOpenAI("system", "user", { model: "test-model" }),
      error => error === failure,
    )
  })
}

test("DONE sentinel rejects an unfinished open stream and cancels its body", async (context) => {
  const client = await createClient(context)
  let cancelled = false
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start (controller) {
      controller.enqueue(new TextEncoder().encode(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: [DONE]\n\n",
      ))
    },
    cancel () {
      cancelled = true
    },
  })))

  await assert.rejects(
    client.chat.callUnofficialOpenAI("system", "user", { model: "test-model" }),
    /ended before completion/,
  )
  assert.equal(cancelled, true)
})

test("unsupported tools and invalid options fail before authentication", async (context) => {
  const client = await createClient(context, null)
  context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected authentication"))

  for (const [system, user, options, expected] of [
    ["system", "user", { model: "test-model", tools: [{ name: "read_coin" }] }, /does not support tools/],
    ["system", "user", {}, /model must be/],
    ["system", "", { model: "test-model" }, /prompts must be/],
    ["system", "user", { model: "test-model", reasoningEffort: 42 }, /reasoningEffort must be/],
  ]) {
    await assert.rejects(client.chat.callUnofficialOpenAI(system, user, options), expected)
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0)
  await assert.rejects(fs.stat(client.tokenUrl), { code: "ENOENT" })
  assert.deepEqual((await fs.readdir(client.root)).sort(), ["src"])
})
