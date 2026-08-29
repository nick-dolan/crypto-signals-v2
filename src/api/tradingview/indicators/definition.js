export function defineIndicator (group, definition) {
  return Object.freeze({
    ...definition,
    group,
    fields: Object.freeze({ ...definition.fields }),
    inputs: Object.freeze({ ...definition.inputs }),
  })
}
