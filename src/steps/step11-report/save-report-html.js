import fs from "node:fs/promises"
import path from "node:path"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc.js"

dayjs.extend(utc)

export async function saveReportHtml (html, reportCreatedAt, directory = path.resolve("reports")) {
  const timestamp = dayjs(reportCreatedAt).utcOffset(180).format("YYYY-MM-DD_HH-mm-ss")
  await fs.mkdir(directory, { recursive: true })

  for (let duplicate = 0; ; duplicate += 1) {
    const suffix = duplicate ? `-${duplicate}` : ""
    const filePath = path.join(directory, `report-${timestamp}_GMT+3${suffix}.html`)

    try {
      await fs.writeFile(filePath, html, { encoding: "utf8", flag: "wx" })
      return filePath
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error
      }
    }
  }
}
