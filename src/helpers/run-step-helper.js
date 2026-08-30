export async function runStep (stepName, callback) {
  try {
    await callback()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    console.error(`\n❌ ${stepName}: ${message}`)
    process.exitCode = 1
  }
}
