# Realot Worker (keeps your API keys off the website)

One small Cloudflare Worker that holds **all** of Realot's API keys, so none of them sit in code
that visitors can read. It serves three things:

| Part of Realot | Worker route | Key it uses |
| --- | --- | --- |
| Bug icon (report page: text, screenshots, short videos) | `POST /feedback` | `FEEDBACK_API_KEY` |
| Bell (your announcements) | `GET /announcements` | `FEEDBACK_API_KEY` |
| Editor -> Export -> Android APK | `/api/v1/*` | `APK_API_KEY` |

## IMPORTANT: where this folder lives

This folder contains a file with your **real keys** (`.dev.vars`). Keep this folder **outside** the
website folder / GitHub repo that you deploy as the hub. Anything inside a website folder can be
downloaded by anyone. `.dev.vars` is already listed in `.gitignore`, so it won't be committed by
accident if you put this folder in its own private repo.

Your keys are saved in `.dev.vars`. After they are uploaded to Cloudflare they are encrypted and
**cannot be read back**, so back this file up (a password manager is perfect).

## Set it up (5 minutes, free plan is enough)

1. Open a terminal in this folder and run:

   ```
   npm install
   npm run setup
   ```

   `setup` deploys the Worker and uploads both keys from `.dev.vars` as secrets. Wrangler prints the
   Worker's address, something like `https://realot-feedback.<your-name>.workers.dev`.

2. Tell the hub where the Worker is: in the **hub** project open `js/data/hub-config.js` and set

   ```js
   feedbackApiUrl: "https://realot-feedback.<your-name>.workers.dev"
   ```

   Then deploy the hub as usual. That one address is used by the report page, the bell and the
   editor's Android export.

3. Lock it to your site (recommended): in `wrangler.toml` set
   `ALLOWED_ORIGINS = "https://your-hub-domain"` (comma separate several) and run `npm run deploy`.

4. Check it: `https://<worker>/health` should say `{"ok":true}`, and
   `https://<worker>/announcements` should list your messages.

## Changing a key later

Edit the value in `.dev.vars`, then run `npm run secrets`. Nothing in the hub or editor needs to change.

## What the Worker allows

* **Reports:** message up to 10,000 characters; one image (JPG, PNG, WebP, GIF up to 10 MB) or one
  video (MP4, WebM up to 25 MB); the real file type is checked, not just its name; 5 reports per
  visitor per 10 minutes.
* **Android builds:** only what the editor needs (start a build, check on it, cancel it, download the
  APK). Key management and admin routes of the build service are refused. Uploads up to 100 MB,
  6 builds per visitor per hour. The editor sends a placeholder key; the Worker always replaces it
  with the real one.
* Those rate limits are best effort (each Worker instance counts separately). For a hard limit, add
  Cloudflare **Rate limiting rules** for `POST /feedback` and `POST /api/v1/build`
  (Security -> WAF -> Rate limiting rules). `ALLOWED_ORIGINS` only stops other *websites* from using
  the Worker from a browser; it can't stop someone calling it directly, which is what the rate limits are for.

## Safety notes

* Never put a key in `hub-config.js`, `wrangler.toml`, or any file of the website.
* If a key is ever exposed, make a new one on that service, put it in `.dev.vars`, run
  `npm run secrets`, then delete the old one.
* Announcement text from the server is shown as plain text in the hub (never as HTML).
