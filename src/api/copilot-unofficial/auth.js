import "dotenv/config"

import fs from "node:fs/promises"
import { sleep } from "radash"
import { isNumber, isString } from "../../helpers/utils.typed.js"

// Experimental client for Copilot's undocumented HTTP API, isolated from the official SDK.
let currentSession = null

async function readJson (fileUrl) {
  try {
    return JSON.parse(await fs.readFile(fileUrl, "utf8"))
  } catch {
    return null
  }
}

async function writePrivateJson (fileUrl, data) {
  await fs.writeFile(fileUrl, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.chmod(fileUrl, 0o600)
}

async function loadGithubToken () {
  const data = await readJson(new URL("../../../.github-token.json", import.meta.url))

  return isString(data?.token) ? data.token : ""
}

async function saveGithubToken (token) {
  await writePrivateJson(
    new URL("../../../.github-token.json", import.meta.url),
    { token, updatedAt: new Date().toISOString() },
  )
}

async function githubDeviceLogin () {
  console.log("\nGitHub Device Code Login\n")

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "Iv1.b507a08c87ecfe98",
      scope: "read:user",
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Device code request failed: HTTP ${response.status}`)
  }

  const data = await response.json()

  console.log(`  1. Open: ${data.verification_uri}`)
  console.log(`  2. Code: ${data.user_code}`)
  console.log("\n  Waiting for authorization...")

  const expiresAt = Date.now() + data.expires_in * 1000
  const intervalMs = Math.max(1000, (data.interval || 5) * 1000)

  while (Date.now() < expiresAt) {
    await sleep(intervalMs)

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: "Iv1.b507a08c87ecfe98",
        device_code: data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!tokenResponse.ok) {
      throw new Error(`Token poll failed: HTTP ${tokenResponse.status}`)
    }

    const tokenData = await tokenResponse.json()

    if (isString(tokenData.access_token) && tokenData.access_token) {
      console.log("\n  GitHub authorized")
      await saveGithubToken(tokenData.access_token)
      return tokenData.access_token
    }

    if (tokenData.error === "authorization_pending") {
      continue
    }

    if (tokenData.error === "slow_down") {
      await sleep(2000)
      continue
    }

    if (tokenData.error === "expired_token") {
      throw new Error("Device code expired, run login again")
    }

    if (tokenData.error === "access_denied") {
      throw new Error("GitHub login was cancelled")
    }

    throw new Error(`GitHub OAuth failed: ${tokenData.error || "unknown error"}`)
  }

  throw new Error("Device code expired, run login again")
}

function deriveCopilotBaseUrl (token) {
  const proxyEndpoint = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]

  if (!proxyEndpoint) {
    return "https://api.individual.githubcopilot.com"
  }

  const urlText = /^https?:\/\//i.test(proxyEndpoint)
    ? proxyEndpoint
    : `https://${proxyEndpoint}`

  try {
    const host = new URL(urlText).hostname.replace(/^proxy\./i, "api.")
    return `https://${host}`
  } catch {
    return "https://api.individual.githubcopilot.com"
  }
}

function isFreshSession (session) {
  return isString(session?.token)
    && session.token.length > 0
    && isNumber(session.expiresAt)
    && session.expiresAt > Date.now() + 5 * 60 * 1000
}

async function loadCopilotSession () {
  const session = await readJson(new URL("../../../.copilot-token.json", import.meta.url))

  if (!isFreshSession(session)) {
    return null
  }

  return {
    ...session,
    baseUrl: isString(session.baseUrl)
      ? session.baseUrl
      : deriveCopilotBaseUrl(session.token),
  }
}

async function saveCopilotSession (session) {
  await writePrivateJson(
    new URL("../../../.copilot-token.json", import.meta.url),
    session,
  )
}

async function exchangeCopilotToken (githubToken) {
  const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${githubToken}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Copilot token exchange failed: HTTP ${response.status} ${body}`)
  }

  const data = await response.json()

  if (!isString(data.token) || !data.token) {
    throw new Error("Copilot token exchange returned no token")
  }

  const expiresAt = isNumber(data.expires_at)
    ? (data.expires_at < 100_000_000_000 ? data.expires_at * 1000 : data.expires_at)
    : Date.now() + 30 * 60 * 1000
  const session = {
    token: data.token,
    expiresAt,
    baseUrl: deriveCopilotBaseUrl(data.token),
    updatedAt: Date.now(),
  }

  await saveCopilotSession(session)
  return session
}

export async function getUnofficialCopilotSession () {
  if (isFreshSession(currentSession)) {
    return currentSession
  }

  const cachedSession = await loadCopilotSession()

  if (cachedSession) {
    const minutesRemaining = Math.round((cachedSession.expiresAt - Date.now()) / 60_000)
    console.log(`Using cached unofficial Copilot token (${minutesRemaining} min remaining)`)
    currentSession = cachedSession
    return cachedSession
  }

  let githubToken = process.env.COPILOT_GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN
    || await loadGithubToken()

  if (!githubToken) {
    githubToken = await githubDeviceLogin()
  }

  console.log("Exchanging GitHub token for unofficial Copilot session...")
  currentSession = await exchangeCopilotToken(githubToken)
  console.log(`Unofficial Copilot session ready (base: ${currentSession.baseUrl})\n`)

  return currentSession
}
