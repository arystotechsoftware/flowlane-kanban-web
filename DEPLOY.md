# FlowLane — Cloudflare Pages Deployment Guide

Deploy both the **landing page** (`flowlanekanban.com`) and the **web app** (`app.flowlanekanban.com`) on Cloudflare Pages. The **Free plan** is more than enough for both.

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Your domain (`flowlanekanban.com`) added to Cloudflare DNS
- A GitHub (or GitLab) repo containing this project
- Firebase project set up (see `INSTALL.md` §1-§3)

---

## Why Cloudflare Free Plan Is Enough

| Feature | Free Plan Limit | FlowLane Usage |
|---|---|---|
| Requests/month | Unlimited | ✅ More than enough |
| Bandwidth | Unlimited | ✅ Static files only |
| Build minutes | 500/month | ✅ ~30s per build |
| Concurrent builds | 1 | ✅ Fine for solo/small team |
| Custom domains | Unlimited | ✅ Need 2 (root + app subdomain) |
| SSL/TLS | Free automatic | ✅ Included |
| Global CDN | 300+ cities | ✅ Included |
| Preview deployments | Unlimited | ✅ Great for testing |

**Verdict: Free plan is perfect.** You'd only consider Pro ($20/mo) if you need Web Analytics, more build concurrency, or WAF rules — none of which you need right now.

---

## Step 1: Push to GitHub

Make sure your repo has this structure:

```
your-repo/
├── public/          ← Landing page (flowlanekanban.com)
│   ├── index.html
│   └── logo.png
├── webapp/          ← Web app (app.flowlanekanban.com)
│   ├── index.html
│   ├── css/
│   │   └── app.css
│   ├── js/
│   │   ├── app.js
│   │   ├── auth.js
│   │   ├── board.js
│   │   ├── card-modal.js
│   │   ├── collaboration.js
│   │   ├── db.js
│   │   ├── export.js
│   │   ├── firebase-config.js
│   │   ├── local-storage.js
│   │   ├── paddle.js
│   │   ├── storage.js
│   │   └── ui.js
│   └── icons/
│       ├── icon-16.png
│       ├── icon-32.png
│       └── icon-180.png
├── src/             ← Chrome extension source (not deployed)
├── functions/       ← Firebase Cloud Functions (deployed separately)
└── ...
```

```bash
git add public/ webapp/
git commit -m "Add landing page and web app for Cloudflare Pages deployment"
git push origin main
```

---

## Step 2: Deploy the Landing Page (`flowlanekanban.com`)

### 2a. Create the Pages project

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Create**
2. Select **Pages** → **Connect to Git**
3. Select your GitHub repo
4. Configure the build:

| Setting | Value |
|---|---|
| Project name | `flowlane-landing` |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | _(leave empty)_ |
| Build output directory | `public` |
| Root directory | `/` |

5. Click **Save and Deploy**

> **Why no build command?** The landing page is a single static HTML file with inline CSS/JS — no build step needed. Cloudflare will serve the `public/` folder directly.

### 2b. Add your custom domain

1. After deployment, go to **Settings** → **Custom Domains**
2. Click **Set up a custom domain**
3. Enter `flowlanekanban.com`
4. Cloudflare will auto-create a CNAME record → Click **Activate domain**
5. Also add `www.flowlanekanban.com` (it will redirect to the root)
6. Wait 1-2 minutes for SSL to provision

### 2c. Verify

Visit `https://flowlanekanban.com` — you should see the landing page.

---

## Step 3: Deploy the Web App (`app.flowlanekanban.com`)

### 3a. Create a second Pages project

1. Go to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select the **same GitHub repo**
3. Configure the build:

| Setting | Value |
|---|---|
| Project name | `flowlane-app` |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | _(leave empty)_ |
| Build output directory | `webapp` |
| Root directory | `/` |

4. Click **Save and Deploy**

### 3b. Add the subdomain

1. Go to **Settings** → **Custom Domains**
2. Click **Set up a custom domain**
3. Enter `app.flowlanekanban.com`
4. Cloudflare will auto-create a CNAME → Click **Activate domain**
5. Wait 1-2 minutes for SSL

### 3c. Add SPA routing (important!)

The web app is a single-page app — all routes should serve `index.html`. Create a `_redirects` file:

1. Create `webapp/_redirects` with this content:

```
/*    /index.html   200
```

This tells Cloudflare Pages to serve `index.html` for all paths (SPA fallback).

### 3d. Verify

Visit `https://app.flowlanekanban.com` — you should see the web app auth screen.

---

## Step 4: Configure Firebase for Production

### 4a. Update Firebase config

Edit `webapp/js/firebase-config.js` with your real Firebase credentials:

```js
export const firebaseConfig = {
  apiKey:            "YOUR_FIREBASE_API_KEY",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

### 4b. Add authorized domains in Firebase Console

1. Go to **Firebase Console** → **Authentication** → **Settings** → **Authorized domains**
2. Add:
   - `app.flowlanekanban.com`
   - `flowlanekanban.com`
   - `flowlane-app.pages.dev` (the Cloudflare default domain)

### 4c. Configure Google OAuth consent screen

1. Go to **Google Cloud Console** → **APIs & Credentials** → **OAuth 2.0 Client IDs**
2. Edit your Web Client
3. Under **Authorized JavaScript origins**, add:
   - `https://app.flowlanekanban.com`
4. Under **Authorized redirect URIs**, add:
   - `https://app.flowlanekanban.com/__/auth/handler`
   - `https://your-project.firebaseapp.com/__/auth/handler`

### 4d. Update FUNCTIONS_BASE_URL

In `webapp/js/firebase-config.js`, set the Cloud Functions URL:

```js
export const FUNCTIONS_BASE_URL = 'https://us-central1-your-project-id.cloudfunctions.net';
```

---

## Step 5: Deploy Firebase Cloud Functions

The Cloud Functions (Paddle billing, invites) run on Firebase, not Cloudflare:

```bash
cd functions/
npm install

# Set Paddle secrets
firebase functions:config:set \
  paddle.api_key="YOUR_PADDLE_API_KEY" \
  paddle.webhook_secret="YOUR_PADDLE_WEBHOOK_SECRET" \
  paddle.environment="production"

# Deploy
firebase deploy --only functions
```

---

## Step 6: Configure Paddle Billing

### 6a. Update paddle config

In `webapp/js/firebase-config.js`:

```js
export const paddleConfig = {
  priceId:    'pri_XXXXXXXXXXXX',  // Your Paddle price ID
  successUrl: 'https://app.flowlanekanban.com/?upgrade=success',
  cancelUrl:  'https://app.flowlanekanban.com/?upgrade=cancelled'
};
```

### 6b. Set webhook URL in Paddle Dashboard

1. Go to **Paddle Dashboard** → **Developer tools** → **Notifications**
2. Add webhook endpoint:
   ```
   https://us-central1-YOUR-PROJECT.cloudfunctions.net/paddleWebhook
   ```
3. Subscribe to events:
   - `subscription.activated`
   - `subscription.updated`
   - `subscription.canceled`
   - `transaction.completed`
   - `transaction.payment_failed`

---

## Step 7: DNS Configuration Summary

Your Cloudflare DNS should have these records (auto-created by Pages):

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | `flowlane-landing.pages.dev` | ✅ Proxied |
| CNAME | `www` | `flowlane-landing.pages.dev` | ✅ Proxied |
| CNAME | `app` | `flowlane-app.pages.dev` | ✅ Proxied |

---

## Step 8: Post-Deployment Checklist

- [ ] `https://flowlanekanban.com` loads the landing page with logo
- [ ] `https://www.flowlanekanban.com` redirects to root domain
- [ ] `https://app.flowlanekanban.com` loads the web app
- [ ] Google Sign-In popup works on the web app
- [ ] Free tier: skip auth → create board → add cards → drag & drop
- [ ] Premium tier: sign in → create project → cloud sync works
- [ ] Real-time collaboration: open in 2 tabs → changes sync
- [ ] Theme toggle (dark/light) persists across reloads
- [ ] Mobile responsive layout works on phone
- [ ] Pricing toggle (monthly/annual) animates correctly on landing page
- [ ] Footer "Web App" link points to `app.flowlanekanban.com`
- [ ] Paddle checkout flow completes successfully
- [ ] SSL certificates are valid (green lock) on all domains

---

## Automatic Deployments

Once set up, every `git push` to `main` triggers:
- **Landing page** auto-deploys from `public/`
- **Web app** auto-deploys from `webapp/`

Each push to a non-main branch creates a **preview deployment** at a unique URL (e.g., `abc123.flowlane-app.pages.dev`) — great for testing before merging.

---

## Recommended Cloudflare Settings (Free Plan)

Go to your domain settings and enable:

1. **SSL/TLS** → Set to **Full (strict)**
2. **Speed** → **Auto Minify** → Enable HTML, CSS, JS
3. **Caching** → **Browser Cache TTL** → 4 hours
4. **Page Rules** (optional):
   - `http://flowlanekanban.com/*` → Always Use HTTPS
   - `http://www.flowlanekanban.com/*` → Forwarding URL (301) → `https://flowlanekanban.com/$1`

---

## Troubleshooting

### "Page not found" on the web app
→ Make sure `webapp/_redirects` file exists with `/*    /index.html   200`

### Google Sign-In popup blocked
→ Add your domain to Firebase Auth → Authorized domains

### Firebase auth redirect fails
→ Make sure the OAuth redirect URI includes `/__/auth/handler`

### CSS/JS not loading
→ Check browser DevTools → Network tab for 404s. Ensure `build output directory` is set correctly in Cloudflare Pages.

### Preview deployments show old version
→ Cloudflare caches aggressively. Try hard refresh (Ctrl+Shift+R) or purge cache in Cloudflare dashboard.

---

## Cost Summary

| Service | Plan | Cost |
|---|---|---|
| **Cloudflare Pages** (landing + web app) | Free | $0/mo |
| **Firebase** (Auth + Firestore + Functions) | Spark → Blaze | $0/mo (pay-as-you-go, generous free tier) |
| **Paddle** | Standard | 5% + $0.50 per transaction |
| **Domain** (flowlanekanban.com) | Annual | ~$10-15/yr |
| **Total fixed costs** | | **~$1/mo** (domain amortized) |

You won't need Cloudflare Pro until you have thousands of daily users and need advanced WAF rules or web analytics. The free plan handles everything FlowLane needs.
