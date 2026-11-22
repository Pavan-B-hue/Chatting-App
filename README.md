# Reels Lite

A private two-person app. It installs on a phone like a normal app, named **Reels Lite**.

- **Passcode 1 (reels):** opens Instagram Reels.
- **Passcode 2 (chat):** opens the private chat. Anything else shows "Incorrect passcode".
- The app locks itself the moment it is closed, switched away from, or reloaded, and wipes the chat from the page.
- Chat features: text, all emojis, stickers (built-in, plus optional online search), photos, videos, and a live drawing zone you can both draw on.

## How it keeps messages private

Everything is encrypted on your phone with a key made from the chat passcode (PBKDF2, then AES-GCM). The server only forwards scrambled data and cannot read text, photos, drawings or passcodes. Each phone also keeps its own encrypted history, which can only be opened with the chat passcode.

## 1. Put the server online (free)

The app needs a small server so the two phones can reach each other. It must be served over HTTPS (all the options below do this).

**Option A: Render (easiest)**
1. Create a private GitHub repository and upload this folder (without `node_modules`).
2. On render.com choose New > Web Service, connect the repo.
3. Build command `npm install`, start command `npm start`, instance type Free.
4. Render gives you an address like `https://your-name.onrender.com`. That is the app address.

Notes for the free plan: the server sleeps after about 15 minutes without use, so the first open can take around 30 seconds, and it forgets undelivered messages if it restarts. Messages already delivered stay on each phone.

**Option B: your own laptop or a spare PC**
Run `npm install` then `npm start`, and expose it with a free Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`). The address it prints is the app address. Your laptop must stay on.

## 2. Install on both phones

- **Android (Chrome):** open the address, menu (three dots), Install app / Add to Home screen.
- **iPhone (Safari):** open the address, Share, Add to Home Screen.

The icon and name will be "Reels Lite", a plain play-button icon.

## 3. First open (setup, once per phone)

Enter your name, her name, your own reels passcode, and the chat passcode. **The chat passcode must be exactly the same on both phones.** If it differs, the phones end up in different rooms and nothing arrives (there is no error, by design). The reels passcode can be different on each phone.

Use a long chat passcode (a phrase of 8+ characters). The strength of the encryption depends on it.

## Good to know

- No notifications. Messages show up when the app is opened, because a locked app keeps no connection.
- Drawing is live only while you both have the drawing zone open. It is not saved except when you tap "Send to chat".
- Videos up to 9 MB. Photos are shrunk automatically.
- Online sticker search needs a free GIPHY API key (developers.giphy.com). Paste it once in the Stickers panel.
- To start over on a phone, clear the site data for the app (this also deletes that phone's history).
- Android can show the app preview in the recent-apps list. The app locks as it leaves the screen, but a web app cannot fully block screenshots of that preview.

## Files

- `server/server.js`: relay server (Node.js, one dependency: `ws`)
- `public/`: the app (`index.html`, `style.css`, `app.js`, `sw.js`, manifest, icons)
