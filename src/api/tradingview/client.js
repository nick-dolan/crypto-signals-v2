import TradingView from "@mathieuc/tradingview"
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
    sessionId: getRequiredEnvironmentVariable("TV_SESSIONID"),
    sessionIdSign: getRequiredEnvironmentVariable("TV_SESSIONID_SIGN"),
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
  const user = await TradingView.getUser(
    credentials.sessionId,
    credentials.sessionIdSign,
    location,
  )

  return {
    credentials,
    user: getPublicUser(user),
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

function waitForConnection (client, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearInterval(intervalId)
      clearTimeout(timeoutId)
      callback(value)
    }

    const checkConnection = () => {
      if (client.isOpen && client.isLogged) {
        finish(resolve, client)
      }
    }

    client.onConnected(checkConnection)
    client.onDisconnected(() => {
      finish(reject, new Error("TradingView disconnected before authentication completed"))
    })

    const intervalId = setInterval(checkConnection, 50)
    const timeoutId = setTimeout(() => {
      finish(reject, new Error(`TradingView connection timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    checkConnection()
  })
}

async function createConnection (options) {
  const {
    connectionTimeoutMs = 15_000,
    ...clientOptions
  } = options

  if (!isFinite(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
    throw new Error("connectionTimeoutMs must be a positive number")
  }

  const { credentials } = await authenticateForConnection(clientOptions.location)
  const client = new TradingView.Client({
    ...clientOptions,
    token: credentials.sessionId,
    signature: credentials.sessionIdSign,
  })

  client.onDisconnected(() => {
    if (activeClient === client) {
      activeClient = null
    }
  })

  try {
    await waitForConnection(client, connectionTimeoutMs)
    return client
  } catch (error) {
    await client.end()
    throw error
  }
}

export async function validateTradingViewCredentials (options = {}) {
  const { user } = await authenticate(options.location)
  return user
}

export function getTradingViewCookieHeader () {
  const credentials = getCredentials()

  return `sessionid=${credentials.sessionId};sessionid_sign=${credentials.sessionIdSign}`
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

  return TradingView.getIndicator(
    normalizedId,
    normalizedVersion,
    credentials.sessionId,
    credentials.sessionIdSign,
  )
}

export async function connectTradingView (options = {}) {
  if (activeClient?.isOpen && activeClient.isLogged) {
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
    await client.end()
  }
}
