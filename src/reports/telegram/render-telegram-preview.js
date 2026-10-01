function escapeHtml (value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character])
}

export function renderTelegramPreview (manifest) {
  const messages = manifest.messages.map((message, index) => `<article class="bubble">
    <h3>Сообщение ${index + 1}</h3>
    <div class="telegram-html">${message.text}</div>
  </article>`).join("\n")
  const cards = manifest.candidates.map(item => `<figure class="card">
    <header class="card-heading">
      <h3>#${escapeHtml(item.number)} · ${escapeHtml(item.symbol)}</h3>
      <p>${escapeHtml({ top: "Топ-кандидаты", positive: "Позитивный инфоповод", coingecko: "В тренде CoinGecko" }[item.section] ?? item.section)}</p>
    </header>
    <img src="${escapeHtml(item.image)}" alt="Карточка #${escapeHtml(item.number)} · ${escapeHtml(item.symbol)}" width="1200" height="1280" loading="lazy">
    <figcaption>
      <p class="caption-label">Подпись к фото #${escapeHtml(item.number)}</p>
      <div class="telegram-html">${item.caption}</div>
    </figcaption>
  </figure>`).join("\n")

  // Message bodies and captions are already escaped Telegram HTML from the builder.
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
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    h1, h2, h3, p, figure { margin: 0; }
    h1 { font-size: clamp(24px, 5vw, 34px); margin: 8px 0 16px; }
    h2 { font-size: 21px; margin: 28px 0 14px; }
    h3 { font-size: 16px; }
    a { color: #83c7ff; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid #83c7ff; outline-offset: 3px; }
    .status { color: #93dfc0; font-weight: 700; }
    .note, .meta, .card-heading p, .caption-label, .bubble h3 { color: #b0c1cf; }
    .meta { display: grid; gap: 6px; overflow-wrap: anywhere; }
    .counts { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 18px 0; }
    .counts span { padding: 6px 12px; background: #223646; border-radius: 8px; }
    .warning { padding: 14px 18px; margin: 18px 0; border: 1px solid #d7ac67; border-radius: 12px; background: #3a3023; color: #ffdb9e; }
    .messages { display: grid; gap: 16px; }
    .bubble { width: 100%; max-width: 720px; min-width: 0; padding: 18px 22px; border-radius: 16px 16px 16px 4px; background: #21394a; }
    .bubble h3 { margin-bottom: 12px; font-size: 13px; font-weight: 500; }
    .telegram-html { white-space: pre-wrap; overflow-wrap: anywhere; }
    .photo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
    .card { min-width: 0; overflow: hidden; border-radius: 16px; border: 1px solid #344b5e; background: #1c2f3e; }
    .card-heading, figcaption { padding: 16px 18px; overflow-wrap: anywhere; }
    .card-heading p, .caption-label { font-size: 13px; margin-top: 4px; }
    .caption-label { margin: 0 0 10px; }
    .card img { display: block; width: 100%; height: auto; }
    footer { margin-top: 32px; border-top: 1px solid #344b5e; padding-top: 18px; }
    @media (max-width: 680px) {
      main { padding: 20px 12px 32px; }
      .photo-grid { grid-template-columns: 1fr; }
      .bubble { padding: 16px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="status">Локальное превью · Не отправлено</p>
      <h1>Telegram-выпуск</h1>
      <div class="meta">
        <p>Открытие последней закрытой свечи (UTC): ${escapeHtml(manifest.asOf)}</p>
        <p>Свеча закрыта (UTC): ${escapeHtml(manifest.closedAt)}</p>
        <p>Источник: <span>${escapeHtml(manifest.source ?? "Не указан")}</span></p>
      </div>
      ${manifest.demo === true ? "<p class=\"warning\"><b>ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ.</b> Монеты, оценки и события вымышлены. Это не рыночный сигнал.</p>" : ""}
      <div class="counts">
        <span>Кандидаты: ${escapeHtml(manifest.candidates.length)} / 10</span>
        <span>Подходящих: ${escapeHtml(manifest.eligibleCount)}</span>
        <span>Не включено: ${escapeHtml(manifest.omittedCount)}</span>
        <span>Сообщения: ${escapeHtml(manifest.messages.length)}</span>
      </div>
      <p class="note">Это не точная попиксельная имитация альбома Telegram: показаны тексты, порядок фото и их подписи.</p>
    </header>
    <section aria-labelledby="messages-heading">
      <h2 id="messages-heading">Текст выпуска</h2>
      <div class="messages">${messages || "<p class=\"note\">Текстовых сообщений нет.</p>"}</div>
    </section>
    <section aria-labelledby="photos-heading">
      <h2 id="photos-heading">Фото и подписи · ${escapeHtml(manifest.candidates.length)} / 10</h2>
      ${cards ? `<div class="photo-grid">${cards}</div>` : "<p class=\"note\">Подходящих кандидатов нет. Фото не созданы.</p>"}
    </section>
    <footer class="note">Только локальные файлы, без отправки в Telegram и обновления данных. Ссылки в сообщениях открываются только вручную.</footer>
  </main>
</body>
</html>`
}
