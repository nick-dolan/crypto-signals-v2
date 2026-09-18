import { isArray, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"

export function decodeAgentPayload (payload) {
  if (!isObject(payload?.schema)) {
    throw new Error("Step 6 schema must define named groups of columns; regenerate step 6 for older payloads")
  }

  const groups = Object.entries(payload.schema)

  if (groups.some(([group, fields]) => (
    !group.trim()
    || ["symbol", "name", "selectionRank", "flags"].includes(group)
    || !isArray(fields)
    || fields.some(field => !isString(field) || !field.trim())
  ))) {
    throw new Error("Step 6 schema must define named groups of non-empty column names")
  }

  const fields = ["symbol", "name", ...groups.flatMap(([, columns]) => columns), "flags"]

  if (new Set(fields).size !== fields.length || fields.includes("selectionRank")) {
    throw new Error("Step 6 schema must contain unique column names without reserved metadata")
  }

  if (!isArray(payload.candidates)) {
    throw new Error("Step 6 candidates must be an array")
  }

  const candidateKeys = ["symbol", "name", "selectionRank", ...groups.map(([group]) => group), "flags"]
  const candidates = payload.candidates.map((candidate, index) => {
    if (
      !isObject(candidate)
      || Object.keys(candidate).length !== candidateKeys.length
      || Object.keys(candidate).some(key => !candidateKeys.includes(key))
      || groups.some(([group, columns]) => (
        !isArray(candidate[group]) || candidate[group].length !== columns.length
      ))
    ) {
      throw new Error(`Step 6 candidate ${index} groups must match the schema length and keys`)
    }

    for (const field of ["symbol", "name"]) {
      if (!isString(candidate[field]) || !candidate[field].trim()) {
        throw new Error(`Step 6 candidate ${index} contains an invalid ${field}`)
      }
    }

    if (!isSafeInteger(candidate.selectionRank) || candidate.selectionRank < 1) {
      throw new Error(`Step 6 candidate ${index} contains an invalid selectionRank`)
    }

    if (!isArray(candidate.flags)) {
      throw new Error(`Step 6 candidate ${index} flags must be an array`)
    }

    // selectionRank describes input order, not an additional market feature or evidence.
    return {
      symbol: candidate.symbol,
      name: candidate.name,
      ...Object.fromEntries(groups.flatMap(([group, columns]) => (
        columns.map((field, column) => [field, candidate[group][column]])
      ))),
      flags: candidate.flags,
    }
  })

  return { fields, candidates }
}
