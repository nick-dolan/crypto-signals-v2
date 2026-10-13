# Отчёты по таймеру

Запуски каждый день в **10:00, 16:00 и 22:00 по UTC+3** (`Europe/Moscow`); ночная пауза — 12 часов.

С `Persistent=true` пропущенные во время отключения сервера или таймера запуски компенсируются одним запуском при активации таймера.

Команда чтобы узнать когда след. таймер.

```bash
systemctl list-timers --all crypto-signals.timer
```

## 1. Подготовка

Сверьте `User`, `Group`, `WorkingDirectory` и `ExecStart` в `crypto-signals.service` с данными сервера:

```bash
id -un
id -gn
pwd
command -v pnpm
```

В `ExecStart` нужен абсолютный путь к `pnpm`. Комментарии в unit-файлах пишите отдельной строкой.

## 2. Установка

Выполните из каталога проекта на сервере. Если задача уже запускается другим таймером, сначала отключите его, чтобы избежать дублей.

```bash
/etc/systemd/system/
```

```bash
sudo cp systemd/crypto-signals.service systemd/crypto-signals.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crypto-signals.timer
```

## 3. Проверка

```bash
systemctl list-timers --all crypto-signals.timer
systemctl status crypto-signals.timer crypto-signals.service
```

После успешного завершения `oneshot`-сервиса статус `inactive (dead)` — нормальное состояние.

## 4. Управление

Ручной запуск вне расписания:

```bash
sudo systemctl start crypto-signals.service
```

После изменения unit-файлов перечитайте конфигурацию и перезапустите таймер:

```bash
sudo systemctl daemon-reload
sudo systemctl restart crypto-signals.timer
```

## 5. Логи

```bash
# В реальном времени
journalctl -u crypto-signals.service -f

# Последние 100 строк
journalctl -u crypto-signals.service -n 100 --no-pager

# За сегодня
journalctl -u crypto-signals.service --since today

# Приоритет err и выше
journalctl -u crypto-signals.service -p err
```

Фильтр `-p err` учитывает приоритет journald, а не текст сообщений приложения.
