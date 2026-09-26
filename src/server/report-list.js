import { isArray, isFinite, isObject, isSafeInteger, isString } from "../helpers/utils.typed.js"
import { HttpError, isReportId } from "./validation.js"

function decodeCursor (value, group) {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Invalid encoding")
    }

    const bytes = Buffer.from(value, "base64url")
    const cursor = JSON.parse(bytes.toString("utf8"))
    if (
      bytes.toString("base64url") !== value
      || !isArray(cursor) || cursor.length !== 4
      || cursor[0] !== 1 || cursor[1] !== group
      || !isSafeInteger(cursor[2]) || !isFinite(new Date(cursor[2]).getTime())
      || !isReportId(cursor[3]) || cursor[3] !== cursor[3].toLowerCase()
    ) {
      throw new Error("Invalid cursor data")
    }
    return { at: cursor[2], id: cursor[3] }
  } catch {
    throw new HttpError(400, "Invalid cursor")
  }
}

export function readListOptions (params) {
  for (const key of params.keys()) {
    if (!["group", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) {
      throw new HttpError(400, "Unknown or repeated query parameter")
    }
  }

  const group = params.get("group") ?? "week"
  const limit = params.get("limit") ?? "30"
  if (!["week", "month"].includes(group)) {
    throw new HttpError(400, "group must be week or month")
  }
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) {
    throw new HttpError(400, "limit must be an integer between 1 and 100")
  }

  return {
    group,
    limit: Number(limit),
    cursor: params.has("cursor") ? decodeCursor(params.get("cursor"), group) : null,
  }
}

function metadataRow (metadata) {
  const at = isString(metadata?.reportCreatedAt) ? Date.parse(metadata.reportCreatedAt) : NaN
  if (
    !isObject(metadata) || !isReportId(metadata.id) || !isFinite(at)
    || !/(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.reportCreatedAt)
  ) {
    throw new Error("Invalid report metadata")
  }

  return {
    at,
    metadata: {
      id: metadata.id.toLowerCase(),
      reportCreatedAt: metadata.reportCreatedAt,
      asOf: metadata.asOf,
      candidateCount: metadata.candidateCount,
      universeCoinCount: metadata.universeCoinCount,
    },
  }
}

function calendarGroup (at, group) {
  // Shift once, then use only UTC methods: grouping never depends on the host's TZ or DST.
  const start = new Date(at + 3 * 60 * 60 * 1_000)
  start.setUTCHours(0, 0, 0, 0)
  if (group === "month") {
    start.setUTCDate(1)
    return {
      key: start.toISOString().slice(0, 7),
      label: start.toLocaleDateString("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" }),
    }
  }

  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  const format = date => date.toLocaleDateString("ru-RU", {
    timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric",
  })
  return { key: start.toISOString().slice(0, 10), label: `${format(start)} — ${format(end)}` }
}

export function paginateReports (metadata, { group, limit, cursor }) {
  if (!isArray(metadata)) {
    throw new Error("Invalid report list")
  }

  const rows = metadata.map(metadataRow).sort((first, second) => (
    second.at - first.at
    || (first.metadata.id < second.metadata.id ? 1 : first.metadata.id > second.metadata.id ? -1 : 0)
  ))
  // The last (time, id) key, not an offset, survives inserts and deletion of the anchor report.
  const remaining = cursor
    ? rows.filter(row => row.at < cursor.at || (row.at === cursor.at && row.metadata.id < cursor.id))
    : rows
  const page = remaining.slice(0, limit)
  const groups = new Map()
  for (const row of page) {
    const { key, label } = calendarGroup(row.at, group)
    if (!groups.has(key)) {
      groups.set(key, { key, label, reports: [] })
    }
    groups.get(key).reports.push(row.metadata)
  }

  const last = page.at(-1)
  return {
    groups: [...groups.values()],
    total: rows.length,
    nextCursor: remaining.length > page.length
      ? Buffer.from(JSON.stringify([1, group, last.at, last.metadata.id])).toString("base64url")
      : null,
  }
}
