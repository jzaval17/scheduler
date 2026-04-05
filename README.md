# Target Break Manager

A PWA web app for Target pacesetters to manage team breaks and lunches.

## Features
- Live break board by zone (Checklanes, SCO, Service Desk, Drive Up)
- Countdown timers with overdue alerts
- Coverage enforcement — warns when too many are on break at once
- AI-powered schedule scanner — photo your paper schedule and it imports automatically
- Push notifications when someone is overdue
- Works offline after first load (PWA)
- Installable to your phone's home screen

---

## Deploy to Vercel (free, ~5 minutes)

### Step 1 — Create a GitHub account (if you don't have one)
Go to https://github.com and sign up for free.

### Step 2 — Upload these files to GitHub
1. Go to https://github.com/new
2. Name your repo: `break-manager`
3. Set it to **Private**
4. Click **Create repository**
5. Click **uploading an existing file**
6. Drag all the files from this folder into the upload area
7. Click **Commit changes**

### Step 3 — Deploy on Vercel
1. Go to https://vercel.com and sign up with your GitHub account
2. Click **Add New Project**
3. Select your `break-manager` repo
4. Click **Deploy** — no settings to change
5. In about 60 seconds, Vercel gives you a URL like `break-manager-abc123.vercel.app`

### Step 4 — Add your Anthropic API key (for the scan feature)
The AI schedule scanner needs an API key to read your photos:
1. In Vercel, go to your project → **Settings** → **Environment Variables**
2. You don't need to add the key directly in code — the app calls the Anthropic API directly from the browser
3. Get a free API key at https://console.anthropic.com
4. The key goes directly in the Upload tab when you scan (or you can hardcode it in app.js for personal use — see note below)

> **Note on the API key:** For a personal app only you use, you can open `app.js`,
> find the fetch call to `api.anthropic.com`, and add your key to the headers:
> `"x-api-key": "sk-ant-YOUR-KEY-HERE"`
> Since this is a private app just for you, that's fine.
> Never share the URL publicly if you hardcode the key.

### Step 5 — Install to your phone
1. Open the Vercel URL in Safari (iPhone) or Chrome (Android)
2. iPhone: tap the Share button → **Add to Home Screen**
3. Android: tap the 3-dot menu → **Add to Home Screen**
4. The app now opens fullscreen like a native app with the Target icon

---

## How to use

### Board tab
- Shows all team members grouped by zone
- Tap any person to start their break, mark them returned, or remove them
- Red banner appears at the top when someone is overdue or coverage is exceeded

### Coverage tab
- Overall break load bar (turns amber at 25%, red at 40%)
- Zone tiles show how many are out vs the max allowed
- Highlights red if any zone is over the limit
- Shows who's coming up in the next 20 minutes

### Upload tab
- Tap the camera box and take a photo of your paper break schedule
- Claude reads the names, times, and zones automatically
- Review the detected entries, then tap **Import**
- Or add team members manually with the form below

### Alerts tab
- Overdue breaks and zone violations show here
- Mark people as returned directly from this screen
- Completed breaks are logged for the shift

---

## Files
```
index.html    — Main app HTML
style.css     — All styling
app.js        — App logic, AI scanner, state management
manifest.json — PWA configuration
sw.js         — Service worker (offline support)
vercel.json   — Vercel hosting config
```
