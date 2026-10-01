# Noto Sans для карточки монеты

Неизменённые статические hinted TTF версии **2.008**. Семейство: **Noto Sans**;
Regular — вес **400**, Bold — **700**. Системные шрифты не используются.

## Источник и фиксация

Официальный репозиторий [googlefonts/noto-fonts](https://github.com/googlefonts/noto-fonts)
перенаправляет на [notofonts/noto-fonts](https://github.com/notofonts/noto-fonts).
Закреплённый commit: `ffebf8c1ee449e544955a7e813c54f9b73848eac`.

- TTF: [`hinted/ttf/NotoSans/`](https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans), имена сохранены.
- [`OFL.txt`](./OFL.txt): оригинальный [`LICENSE`](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/LICENSE) из того же commit, без изменения содержимого — **SIL Open Font License 1.1**.

| Файл | Размер, байт |
| --- | ---: |
| `NotoSans-Regular.ttf` | 569208 |
| `NotoSans-Bold.ttf` | 575740 |
| `OFL.txt` | 4377 |

SHA-256 (проверка из этого каталога: `shasum -a 256 NotoSans-Regular.ttf NotoSans-Bold.ttf OFL.txt`):

```text
b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5  NotoSans-Regular.ttf
c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a  NotoSans-Bold.ttf
0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb  OFL.txt
```

Проверены Git blob-хэши всех трёх файлов по GitHub API закреплённого commit,
таблицы `name`, `OS/2` и Unicode `cmap`: в обоих TTF есть все **256 символов
U+0400–U+04FF**, в том числе все **66 русских букв**, включая **Ё/ё**.

## Подключение к resvg

В опциях `font` задавать `fontFiles` с абсолютными путями к **обоим локальным TTF**,
`loadSystemFonts: false` и `defaultFontFamily: 'Noto Sans'`.
Для ES-модуля в `src/reports/coin-card/` путь к Regular:
`fileURLToPath(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url))`
(`fileURLToPath` из `node:url`); к Bold — аналогично с `NotoSans-Bold.ttf`.
В SVG: `font-family="Noto Sans"`, `font-weight="400"` или `font-weight="700"`.
