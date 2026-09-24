import fs from "node:fs/promises"
import path from "node:path"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc.js"

import { isString } from "../../helpers/utils.typed.js"

dayjs.extend(utc)

export async function savePeerRadarReport (report, directory = path.resolve("reports")) {
  if (!isString(report.generatedAt) || !dayjs(report.generatedAt).isValid()) {
    throw new Error("Peer radar report generatedAt must be a valid timestamp")
  }

  const timestamp = dayjs(report.generatedAt).utcOffset(180).format("YYYY-MM-DD_HH-mm-ss")
  const content = JSON.stringify(report, null, 2)
  await fs.mkdir(directory, { recursive: true })

  for (let duplicate = 0; ; duplicate += 1) {
    const suffix = duplicate ? `-${duplicate}` : ""
    const filePath = path.join(directory, `peer-radar-${timestamp}_GMT+3${suffix}.json`)

    try {
      await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" })
      return filePath
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error
      }
    }
  }
}
