import fs from "node:fs/promises"

export async function renderIconSprite () {
  const symbols = await Promise.all([
    "hand-fist", "megaphone", "star", "arrow-up", "arrow-down", "arrows-left-right", "minus",
    "arrow-up-right-from-square", "arrow-left", "arrow-right", "diamond",
  ].map(async (name) => {
    const svg = await fs.readFile(new URL(`./icons/${name}.svg`, import.meta.url), "utf8")
    const [, viewBox, content] = svg.match(/<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/)
    return `<symbol id="icon-${name}" viewBox="${viewBox}">${content}</symbol>`
  }))
  return `<svg class="icon-definitions" aria-hidden="true" focusable="false" width="0" height="0" xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>`
}
