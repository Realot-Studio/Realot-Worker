# Realot Worker (keeps your API keys off the website)

One small Cloudflare Worker that holds **all** of Realot's API keys, so none of them sit in code
that visitors can read. It serves three things:

| Part of Realot | Worker route | Key it uses |
| --- | --- | --- |
| Bug icon (report page: text, screenshots, short videos) | `POST /feedback` | `FEEDBACK_API_KEY` |
| Bell (your announcements) | `GET /announcements` | `FEEDBACK_API_KEY` |
| Editor -> Export -> Android APK | `/api/v1/*` | `APK_API_KEY` |

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/realot-worker)

**Before clicking the button:** Cloudflare's one-click deploy button needs this Worker to be in a
**public GitHub or GitLab repository**. Create a **public** repository named `realot-worker`, then upload the project files to the
repository root (so `wrangler.toml`, `package.json`, and `worker.js` are at the top level). **Do not
upload `.dev.vars`**. The `.gitignore` rule protects normal Git commits, but it does not protect you
when manually dragging files into GitHub in a browser. Replace `YOUR_GITHUB_USERNAME` in the button
link above with your GitHub username. Then click **Deploy to Cloudflare**, connect your Cloudflare
account, review the Worker settings, and deploy.

**Important: deployment does not upload your private API keys.** The `.dev.vars` file is excluded
from Git by `.gitignore`, and it must stay private. After the Worker is deployed, open Cloudflare
Dashboard -> **Workers & Pages** -> **realot-feedback** -> **Settings** -> **Variables and Secrets**.
Add these two items using the **Secret** type, entering the freshly rotated values from your secure
password manager or local private copy:

| Secret name | Used for |
| --- | --- |
| `FEEDBACK_API_KEY` | Bug reports and announcements |
| `APK_API_KEY` | Android APK builds |

Save the secrets and deploy the updated Worker version. Do not paste secret values into this README,
GitHub, `wrangler.toml`, or your website. If either key has ever been exposed, replace it with a new
key at the service that issued it before deploying.

The Cloudflare button creates a Git-connected project. Future commits pushed to that repository can
automatically trigger deployments. See [Cloudflare's Deploy to Cloudflare button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## IMPORTANT: where this folder lives

This folder contains a file with your **real keys** (`.dev.vars`). Keep this folder outside the
website folder / GitHub repo that you deploy as the hub. Anything inside a website folder can be
downloaded by anyone. `.dev.vars` is listed in `.gitignore`, but still check that it is not included
in any commit or upload. Keep a private backup of your replacement keys in a password manager.

## Set it up locally (alternative to the deploy button)

If you prefer to deploy from your computer, open a terminal in this folder and run:

```
npm install
npm run setup
```

`setup` deploys the Worker and uploads both keys from `.dev.vars` as secrets. Wrangler prints the
Worker's address, something like `https://realot-feedback.<your-name>.workers.dev`.

## Connect the hub to the Worker

In the **hub** project open `js/data/hub-config.js` and set:

```js
feedbackApiUrl: "https://realot-feedback.<your-name>.workers.dev"
```

Replace the example with the actual Worker URL shown by Cloudflare, then deploy the hub as usual.
That one address is used by the report page, the bell and the editor's Android export.

## Restrict which website origins can call the Worker

In `wrangler.toml`, set `ALLOWED_ORIGINS` to your actual hub website origin, for example
`https://your-hub-domain` (comma separate several origins). Do not include a trailing slash. Keep
it empty only while testing. After changing it, deploy again. With the Git-connected deploy button,
commit and push the configuration change to the repository.

## Check the deployment

Open these URLs, replacing `<worker>` with your deployed Worker hostname:

- `https://<worker>/health` should return `{"ok":true}`.
- `https://<worker>/announcements` should return an object containing an `items` array. It can be
  empty if you have not published announcements yet.

A successful `/health` response confirms the Worker is running. A successful `/announcements`
response also checks the feedback service connection and its API key.

## Changing a key later

For a local deployment, edit the value in `.dev.vars`, then run `npm run secrets`. For a
Git-connected deployment, update the relevant secret under **Workers & Pages -> realot-feedback ->
Settings -> Variables and Secrets**. Secret values are not shown again after saving, so keep your
replacement keys in a password manager.

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
* If a key is ever exposed, make a new one on that service, put it in `.dev.vars` for local deployment
  or enter it as a Cloudflare Worker secret, then delete the old one.
* Announcement text from the server is shown as plain text in the hub (never as HTML).
