function escapeHtml (value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character])
}

export function renderTelegramPreview (manifest) {
  const candidates = new Map(manifest.candidates.map(item => [item.mediaId, item]))
  // Rich HTML is trusted builder output; only Telegram media tags need browser equivalents.
  const post = manifest.richMessage.html
    .replace(/<tg-collage>/g, "<div class=\"photo-grid\">")
    .replace(/<\/tg-collage>/g, "</div>")
    .replace(/<img src="tg:\/\/photo\?id=(card_\d+)"\/>/g, (_, id) => {
      const item = candidates.get(id)
      if (!item || !/^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/i.test(item.image)) {
        throw new Error(`Нет локальной карточки для rich-фото ${id}`)
      }
      return `<img src="${escapeHtml(item.image)}" alt="Карточка #${escapeHtml(item.number)} · ${escapeHtml(item.symbol)}" width="1200" height="1280" loading="lazy">`
    })

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Локальное превью · ${escapeHtml(manifest.closedAt)}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, sans-serif; color: #eaf1f8; background: #101b25; }
    * { box-sizing: border-box; }
    body { margin: 0; line-height: 1.55; }
    main { max-width: 760px; margin: 0 auto; padding: 28px 20px 48px; }
    h1, p { margin: 0; }
    h1 { font-size: clamp(24px, 5vw, 34px); margin: 8px 0 16px; }
    a { color: #83c7ff; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid #83c7ff; outline-offset: 3px; }
    .status { color: #93dfc0; font-weight: 700; }
    .note, .meta { color: #b0c1cf; }
    .meta { display: grid; gap: 6px; overflow-wrap: anywhere; }
    .counts { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 18px 0; }
    .counts span { padding: 6px 12px; background: #223646; border-radius: 8px; }
    .warning { padding: 14px 18px; margin: 18px 0; border: 1px solid #d7ac67; border-radius: 12px; background: #3a3023; color: #ffdb9e; }
    .bubble { width: 100%; max-width: 720px; min-width: 0; margin-top: 24px; padding-bottom: 6px; overflow: hidden; border-radius: 16px 16px 16px 4px; background: #21394a; }
    .telegram-html { overflow-wrap: anywhere; }
    .telegram-html p { padding: 0 22px; margin: 18px 0; }
    .telegram-html img { display: block; width: 100%; height: auto; }
    .photo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
    footer { margin-top: 32px; border-top: 1px solid #344b5e; padding-top: 18px; }
    @media (max-width: 680px) {
      main { padding: 20px 12px 32px; }
      .photo-grid { grid-template-columns: 1fr; }
      .telegram-html p { padding: 0 16px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="status">Локальное превью · Один пост</p>
      <h1>Telegram-выпуск</h1>
      <div class="meta">
        <p>Открытие последней закрытой свечи (UTC): ${escapeHtml(manifest.asOf)}</p>
        <p>Свеча закрыта (UTC): ${escapeHtml(manifest.closedAt)}</p>
        <p>Источник: <span>${escapeHtml(manifest.source ?? "Не указан")}</span></p>
      </div>
      ${manifest.demo === true ? "<p class=\"warning\"><b>ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ.</b> Монеты, оценки и события вымышлены. Это не рыночный сигнал.</p>" : ""}
      <div class="counts">
        <span>Кандидаты: ${escapeHtml(manifest.candidates.length)}</span>
        <span>Подходящих: ${escapeHtml(manifest.eligibleCount)}</span>
        <span>Не включено: ${escapeHtml(manifest.omittedCount)}</span>
        <span>Сообщения: 1</span>
      </div>
      <p class="note">Это локальное представление одного поста. Точное отображение в клиентах Telegram не гарантируется.</p>
    </header>
    <article class="bubble" aria-label="Один пост">
      <div class="telegram-html">${post}</div>
    </article>
    <footer class="note">Превью использует только локальные файлы и не обновляет данные. Ссылки открываются только вручную.</footer>
  </main>
</body>
</html>`
}
