import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { sleep } from "radash"
import { isFinite, isString, isURLSearchParams } from "../../helpers/utils.typed.js"

let currentSession = null
let pendingSession = null
let unsavedSession = false

function isSession (session) {
  return isString(session?.token) && session.token.trim().length > 0
    && isString(session.refreshToken) && session.refreshToken.trim().length > 0
    && isString(session.accountId) && session.accountId.trim().length > 0
    && isFinite(session.expiresAt) && session.expiresAt > 0
}

async function loadSession () {
  let text

  try {
    text = await fs.readFile(new URL("../../../.openai-token.json", import.meta.url), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }

    throw error
  }

  let session

  try {
    session = JSON.parse(text)
  } catch {
    throw new Error("Invalid OpenAI token file; sign in again with getUnofficialOpenAISession({ login: true })")
  }

  if (!isSession(session)) {
    throw new Error("Invalid OpenAI session; sign in again with getUnofficialOpenAISession({ login: true })")
  }

  return session
}

async function saveSession (session) {
  const temporaryUrl = new URL(`../../../.openai-token.${randomUUID()}.tmp`, import.meta.url)

  try {
    await fs.writeFile(temporaryUrl, JSON.stringify(session, null, 2), { mode: 0o600, flag: "wx" })
    await fs.rename(temporaryUrl, new URL("../../../.openai-token.json", import.meta.url))
  } finally {
    await fs.rm(temporaryUrl, { force: true })
  }
}

async function postAuth (endpoint, body, signal = AbortSignal.timeout(30_000)) {
  const form = isURLSearchParams(body)

  return fetch(`https://auth.openai.com${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      "User-Agent": "crypto-signals-v2",
      "originator": "crypto-signals-v2",
    },
    body: form ? body : JSON.stringify(body),
    signal,
  })
}

async function readTokenResponse (response, previousRefreshToken) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `OpenAI token request failed: HTTP ${response.status}. Sign in again with getUnofficialOpenAISession({ login: true })`,
    )
  }

  const data = await response.json()
  let accountId

  try {
    const payload = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString("utf8"))
    accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id
  } catch {
    throw new Error("OpenAI token response has no valid ChatGPT account ID")
  }

  const expiresIn = Number(data.expires_in)
  const session = {
    token: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken,
    accountId,
    expiresAt: Date.now() + expiresIn * 1000,
  }

  if (!isFinite(expiresIn) || expiresIn <= 0 || !isSession(session)) {
    throw new Error("OpenAI token response is missing renewable session credentials")
  }

  return session
}

async function deviceLogin () {
  const response = await postAuth("/api/accounts/deviceauth/usercode", {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  })

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `OpenAI device code request failed: HTTP ${response.status}. Check device-code authorization in ChatGPT and retry.`,
    )
  }

  const data = await response.json()
  const userCode = data.user_code ?? data.usercode

  if (!isString(data.device_auth_id) || !data.device_auth_id.trim() || !isString(userCode) || !userCode.trim()) {
    throw new Error("OpenAI device code response is missing the device ID or user code")
  }

  console.log("\nOpenAI Device Code Login")
  console.log("  Open: https://auth.openai.com/codex/device")
  console.log(`  Code: ${userCode}\n  Waiting for authorization...`)

  const interval = Number(data.interval)
  const intervalMs = isFinite(interval) && interval > 0 ? Math.max(1000, interval * 1000) : 5000
  const deadline = Date.now() + 15 * 60 * 1000

  while (Date.now() < deadline) {
    const tokenResponse = await postAuth("/api/accounts/deviceauth/token", {
      device_auth_id: data.device_auth_id,
      user_code: userCode,
    }, AbortSignal.timeout(Math.min(30_000, deadline - Date.now())))

    if (tokenResponse.status === 403 || tokenResponse.status === 404) {
      await tokenResponse.body?.cancel()
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
      continue
    }

    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel()
      throw new Error(`OpenAI device authorization failed: HTTP ${tokenResponse.status}`)
    }

    const authorization = await tokenResponse.json()

    if (!isString(authorization.authorization_code) || !authorization.authorization_code.trim()
      || !isString(authorization.code_verifier) || !authorization.code_verifier.trim()) {
      throw new Error("OpenAI device authorization response is missing the exchange code")
    }

    return readTokenResponse(await postAuth("/oauth/token", new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: authorization.authorization_code,
      code_verifier: authorization.code_verifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    })))
  }

  throw new Error("OpenAI device authorization timed out after 15 minutes; start login again")
}

async function resolveSession ({ login = false, rejectedToken } = {}) {
  const session = login ? null : currentSession ?? await loadSession()

  if (session && session.expiresAt > Date.now() + 60_000 && session.token !== rejectedToken) {
    if (unsavedSession) {
      await saveSession(session)
      unsavedSession = false
    }

    currentSession = session
    return session
  }

  const updated = session
    ? await readTokenResponse(await postAuth("/oauth/token", new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token: session.refreshToken,
      })), session.refreshToken)
    : await deviceLogin()

  // Keep a rotated token in memory even if saving fails; never replay its old refresh token.
  currentSession = updated
  unsavedSession = true
  await saveSession(updated)
  unsavedSession = false
  return updated
}

export async function getUnofficialOpenAISession (options = {}) {
  while (pendingSession) {
    await pendingSession
  }

  pendingSession = resolveSession(options)

  try {
    return await pendingSession
  } finally {
    pendingSession = null
  }
}
