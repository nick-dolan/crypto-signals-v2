import { isString } from "../helpers/utils.typed.js"

export class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

export function isReportId (value) {
  return isString(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
