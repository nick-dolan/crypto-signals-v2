import { getIndicator, getUser, TradingViewClient } from "@mathieuc/tradingview"
import dotenv from "dotenv"
import { isError, isFinite, isString } from "../../helpers/utils.typed.js"

dotenv.config({ quiet: true })

let activeClient = null
let connectionPromise = null

function getRequiredEnvironmentVariable (name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Environment variable ${name} is required`)
  }

  return value
}

function getCredentials () {
  return {
    session: getRequiredEnvironmentVariable("TV_SESSIONID"),
    signature: getRequiredEnvironmentVariable("TV_SESSIONID_SIGN"),
  }
}

function getPublicUser (user) {
  if (!user?.id || !user.username || !user.authToken) {
    throw new Error("TradingView returned an incomplete authenticated user profile")
  }

  return {
    id: user.id,
    username: user.username,
  }
}

function getErrorMessage (error) {
  return isError(error) ? error.message : "Unknown error"
}

async function authenticate (location) {
  const credentials = getCredentials()
  const user = await getUser(credentials, { location })

  return {
    credentials,
    user: getPublicUser(user),
    authToken: user.authToken,
  }
}

async function authenticateForConnection (location) {
  try {
    return await authenticate(location)
  } catch (error) {
    const validationError = new Error(
      `TradingView credentials validation failed: ${getErrorMessage(error)}`,
      { cause: error },
    )

    console.warn(
      `[TradingView] ${validationError.message}. Client creation stopped.`,
    )

    throw validationError
  }
}

async function createConnection (options) {
  const {
    connectionTimeoutMs = 15_000,
    ...clientOptions
  } = options

  if (!isFinite(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
    throw new Error("connectionTimeoutMs must be a positive number")
  }

  const { authToken } = await authenticateForConnection(clientOptions.location)
  const client = new TradingViewClient({
    ...clientOptions,
    authToken,
    connectTimeoutMs: connectionTimeoutMs,
  })

  client.on("close", () => {
    if (activeClient === client) {
      activeClient = null
    }
  })

  try {
    await client.ready
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}

export async function validateTradingViewCredentials (options = {}) {
  const { user } = await authenticate(options.location)
  return user
}

export function getTradingViewCookieHeader () {
  const credentials = getCredentials()

  return `sessionid=${credentials.session};sessionid_sign=${credentials.signature}`
}

export async function getTradingViewIndicator (id, version = "last") {
  const normalizedId = isString(id) ? id.trim() : ""
  const normalizedVersion = isString(version) ? version.trim() : ""

  if (!normalizedId) {
    throw new Error("TradingView indicator id is required")
  }

  if (!normalizedVersion) {
    throw new Error("TradingView indicator version is required")
  }

  const credentials = getCredentials()

  return getIndicator(normalizedId, { version: normalizedVersion, credentials })
}

export async function connectTradingView (options = {}) {
  if (activeClient?.isOpen && activeClient.isAuthenticated) {
    return activeClient
  }

  if (!connectionPromise) {
    connectionPromise = createConnection(options)
  }

  try {
    activeClient = await connectionPromise
    return activeClient
  } finally {
    connectionPromise = null
  }
}

export async function disconnectTradingView () {
  if (connectionPromise) {
    try {
      await connectionPromise
    } catch {
      return
    }
  }

  const client = activeClient
  activeClient = null

  if (client) {
    await client.close()
  }
}
