# Веб-сервер и ngrok

Две службы работают после закрытия SSH и запускаются после перезагрузки, независимо от таймера пайплайна. Нужны `policy.yaml` в корне проекта и настроенная авторизация ngrok под `nd`.

Завершите ручные процессы веб-сервера и ngrok через `Ctrl+C`. Затем выполните из корня проекта на Ubuntu:

```bash
sudo /usr/local/bin/ngrok update &&
sudo cp systemd/crypto-signals-web.service systemd/crypto-signals-ngrok.service /etc/systemd/system/ &&
sudo systemd-analyze verify /etc/systemd/system/crypto-signals-web.service /etc/systemd/system/crypto-signals-ngrok.service &&
sudo systemctl daemon-reload &&
sudo systemctl enable --now crypto-signals-web.service crypto-signals-ngrok.service
```

Проверка и последние логи:

```bash
systemctl --no-pager --full status crypto-signals-web.service crypto-signals-ngrok.service
sudo journalctl -u crypto-signals-web.service -u crypto-signals-ngrok.service -n 50 --no-pager
```

Сервер слушает только `127.0.0.1:3000`; ограничение внешнего доступа настраивается в `policy.yaml`.

После изменения unit-файлов:

```bash
sudo systemctl daemon-reload &&
sudo systemctl restart crypto-signals-web.service crypto-signals-ngrok.service
```

Отключение обеих служб вместе с автозапуском:

```bash
sudo systemctl disable --now crypto-signals-ngrok.service crypto-signals-web.service
```
