function validateSource (source) {
  if (!Array.isArray(source)) {
    throw new Error("Pivot source must be an array")
  }

  source.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error(`Pivot source at index ${index} must be a finite number`)
    }
  })
}

function validateLength (value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function isPivotHigh (source, pivotIndex, leftLength, rightLength) {
  const pivot = source[pivotIndex]

  for (let offset = 1; offset <= leftLength; offset += 1) {
    if (source[pivotIndex - offset] > pivot) {
      return false
    }
  }

  for (let offset = 1; offset <= rightLength; offset += 1) {
    if (source[pivotIndex + offset] >= pivot) {
      return false
    }
  }

  return true
}

function isPivotLow (source, pivotIndex, leftLength, rightLength) {
  const pivot = source[pivotIndex]

  for (let offset = 1; offset <= leftLength; offset += 1) {
    if (source[pivotIndex - offset] < pivot) {
      return false
    }
  }

  for (let offset = 1; offset <= rightLength; offset += 1) {
    if (source[pivotIndex + offset] <= pivot) {
      return false
    }
  }

  return true
}

function calculatePivots (
  source,
  leftLength,
  rightLength,
  isPivot,
) {
  validateSource(source)
  validateLength(leftLength, "Pivot leftLength")
  validateLength(rightLength, "Pivot rightLength")

  const pivots = Array(source.length).fill(null)

  for (
    let confirmationIndex = leftLength + rightLength;
    confirmationIndex < source.length;
    confirmationIndex += 1
  ) {
    const pivotIndex = confirmationIndex - rightLength

    if (isPivot(source, pivotIndex, leftLength, rightLength)) {
      pivots[confirmationIndex] = source[pivotIndex]
    }
  }

  return pivots
}

export function pivotHigh (source, leftLength, rightLength) {
  return calculatePivots(
    source,
    leftLength,
    rightLength,
    isPivotHigh,
  )
}

export function pivotLow (source, leftLength, rightLength) {
  return calculatePivots(
    source,
    leftLength,
    rightLength,
    isPivotLow,
  )
}
