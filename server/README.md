# Dueck Clicker server

Runs on the old Mac mini (Lubuntu). It handles accounts, cloud saves, leaderboards, visit stats and the
AutoClicker tag. Offline farming stays in the browser. Players reach it through **Tailscale Funnel**, so no
port forwarding is needed.

## One-time setup on the Mac mini

1. On the Mac mini, open GitHub in the browser, press **Code → Download ZIP**, and unzip it (it lands in `Downloads`).
2. Open a terminal in the unzipped folder and run:
   ```bash
   bash server/install.sh
   ```
   It asks for your Lubuntu password a few times. At the end it prints your **admin password**.
   After this you can delete the ZIP. The installer keeps its own copy of the code in `~/dueck`.
3. Put the server on the internet:
   ```bash
   sudo tailscale up
   ```
   Open the link it shows and log in (a free account is fine). Then:
   ```bash
   sudo tailscale funnel --bg 8787
   ```
   The first time, it may give you a link to turn Funnel on. Open it, allow it, and run the command again.
   ```bash
   tailscale funnel status
   ```
   This shows your address, like `https://mac-mini.tail1234.ts.net`.
4. Put that address in the game: in `beta/index.html`, set `DEFAULT_API` to it and push.
   (To test before pushing, open the beta with `?api=https://your-address` on the end of the URL.)

## What happens after that, without touching the Mac mini

- **Power on, crash or reboot:** the server starts by itself at boot (nobody has to log in) and restarts
  within 3 seconds if it ever stops. The installer also tells the Mac mini to **turn itself back on after a
  power cut**. Test it once by pulling the plug and plugging it back in.
- **Updates:** every 5 minutes the Mac mini checks GitHub. When new code in `server/` reaches the `main`
  branch, it downloads it and restarts the server. If the new version won't start, it goes straight back
  to the old one and waits for a fix.
- **Backups:** a copy of the database is made every day in `~/dueck-data/backups` (the last 14 are kept).
- **Sleep** is turned off.

## Admin page

Go to `https://your-address/admin`. Any username works, and the password is the admin password from step 2
(it's also in `~/dueck-data/server.env`). It shows visits, what people open, the players, and anti-cheat
notes, with buttons to hide, ban or remove a tag.

## Anti-cheat

- **AutoClicker tag (automatic):** a player who averages **30+ clicks per second** over at least 20 seconds
  gets `(AutoClicker)` next to their name. Only taps on the face count, and the speed is measured
  generously, so it can only come out lower than the truth. Fast humans manage about 15 per second. You can
  remove a tag from the admin page.
- **Beta Tools:** a beta save that used the cheat tools stays off the leaderboard. Wiping the save puts the
  player back on.
- **Everything else** (like play time jumping ahead) is only a note on the admin page. Nothing happens to
  anyone unless you press a button.

## Handy commands

```bash
systemctl status dueck-server
```
```bash
journalctl -u dueck-server -n 50
```
```bash
journalctl -u dueck-update -n 20
```
```bash
sudo systemctl start dueck-update
```
(The last one checks for an update right now instead of waiting for the next 5-minute check.)

## Is the code being public a problem?

No. The password lives only on the Mac mini (`~/dueck-data/server.env`), never on GitHub. The server only
listens inside the Mac mini, and the tunnel is the only way in. Anyone could copy the code and run their
own empty server, but that can't touch yours, its players or its admin page.
