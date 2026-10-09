import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"

import { renderReportHtml, renderReportPage } from "../src/reports/render-report-html.js"
import { readWebAsset } from "../src/web/read-web-asset.js"
import { renderIconSprite } from "../src/web/render-icon-sprite.js"

test("icon sprite preserves the selected local SVG viewBoxes, paths and attribution comments", async () => {
  const files = (await fs.readdir(new URL("../src/web/icons/", import.meta.url))).sort()
  assert.deepEqual(files, [
    "hand-fist", "megaphone", "star", "arrow-up", "arrow-down", "arrows-left-right", "minus",
    "arrow-up-right-from-square", "arrow-left", "arrow-right", "diamond",
  ].map(name => `${name}.svg`).sort())

  const sprite = await renderIconSprite()
  assert.match(sprite, /^<svg class="icon-definitions" aria-hidden="true" focusable="false" width="0" height="0" xmlns="http:\/\/www\.w3\.org\/2000\/svg">/)
  assert.match(sprite, /\n<\/svg>$/)
  assert.equal([...sprite.matchAll(/<svg\b/g)].length, 1)
  assert.doesNotMatch(sprite, /<(?:script|style|image|use)\b/)

  const symbols = [...sprite.matchAll(/<symbol id="icon-([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)]
  assert.deepEqual(symbols.map(([, name]) => `${name}.svg`).sort(), files)
  await Promise.all(symbols.map(async ([, name, viewBox, content]) => {
    const source = await fs.readFile(new URL(`../src/web/icons/${name}.svg`, import.meta.url), "utf8")
    assert.equal(viewBox, source.match(/\bviewBox="([^"]+)"/)[1], name)
    assert.equal(content, source.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)[1], name)
  }))
})

for (const [name, render] of [
  ["index", async () => (await readWebAsset("index.html")).content],
  ["online report", renderReportPage],
  ["standalone report", () => renderReportHtml({ asOf: "2026-09-25T12:00:00.000Z", coins: [] })],
]) {
  test(`${name} embeds one shared sprite before the UI with decorative local icon references`, async () => {
    const [sprite, html] = await Promise.all([renderIconSprite(), render()])
    assert.equal(html.split(sprite).length, 2, "the shared sprite is embedded exactly once")
    assert.ok(/<body>\s*<svg class="icon-definitions"/.test(html), "the sprite precedes the UI")

    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    assert.doesNotMatch(markup, /<!-- (?:REPORT|WEB)_ICONS -->/)
    assert.doesNotMatch(markup, /<(?:image|use)\b[^>]*href="(?!#)/)
    const ids = new Set([...markup.matchAll(/<symbol id="([^"]+)"/g)].map(([, id]) => id))
    const icons = [...markup.matchAll(/<svg class="icon"\s+aria-hidden="true"\s+focusable="false">\s*<use href="([^"]+)"><\/use>\s*<\/svg>/g)]
    assert.ok(icons.length > 0, "existing UI icons use SVG")
    assert.equal([...markup.matchAll(/<use\b/g)].length, icons.length, "all icon uses are decorative and unfocusable")
    for (const [, href] of icons) {
      assert.ok(href.startsWith("#icon-"), href)
      assert.ok(ids.has(href.slice(1)), `${href} resolves to a local symbol`)
    }
  })
}
