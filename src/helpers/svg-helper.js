import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"

export function escapeXml (value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]).replace(/\p{Cc}/gu, "")
}

export function renderSvgPng (svg) {
  return new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      defaultFontFamily: "Noto Sans",
      fontFiles: [
        fileURLToPath(new URL("../reports/fonts/NotoSans-Regular.ttf", import.meta.url)),
        fileURLToPath(new URL("../reports/fonts/NotoSans-Bold.ttf", import.meta.url)),
      ],
    },
  }).render().asPng()
}
