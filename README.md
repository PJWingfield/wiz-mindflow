# WIZ — Mind Flow Coaching Platform
## Deployment Guide for Beta Launch

---

## What's in This Folder

```
wiz-server/
├── server.js          ← The secure Node.js server (keeps your API key safe)
├── package.json       ← Dependencies
├── .env.example       ← Template for your environment variables
├── .gitignore         ← Prevents your API key going to GitHub
├── README.md          ← This file
└── public/
    └── index.html     ← The WIZ frontend (served by the server)
```

---

## Before You Deploy

You need:
1. Your **Anthropic API key** — get it from [console.anthropic.com](https://console.anthropic.com)
2. A free account on **Railway** OR **Render** (both work, both free for beta)

---

## Option A: Deploy to Railway (Recommended — simplest)

Railway is the fastest option. Takes about 5 minutes.

### Step 1: Create a GitHub repository
1. Go to [github.com](https://github.com) — create a free account if you don't have one
2. Create a new repository called `wiz-mindflow`
3. Upload everything in this folder to that repository
   - **Important**: do NOT upload your `.env` file — only upload `.env.example`

### Step 2: Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign up with your GitHub account
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `wiz-mindflow` repository
4. Railway detects it's a Node.js app automatically

### Step 3: Add your environment variables
1. In Railway, go to your project → **"Variables"** tab
2. Add these variables:
   ```
   ANTHROPIC_API_KEY = sk-ant-your-actual-key-here
   ADMIN_KEY         = choose-any-secret-password
   ALLOWED_ORIGIN    = *
   ```
3. Click **"Deploy"**

### Step 4: Get your URL
Railway gives you a URL like `https://wiz-mindflow-production.up.railway.app`

That's it. Share that URL with your beta testers.

---

## Option B: Deploy to Render (Also Free)

1. Go to [render.com](https://render.com) and create a free account
2. Click **"New"** → **"Web Service"**
3. Connect your GitHub repository
4. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: Node
5. Add environment variables (same as Railway above)
6. Click **"Create Web Service"**

Render gives you a URL like `https://wiz-mindflow.onrender.com`

**Note**: Render's free tier spins down after 15 minutes of inactivity. First load after sleep takes ~30 seconds. Fine for beta; upgrade for production.

---

## Testing Locally (Before Deploying)

If you want to test on your own computer first:

```bash
# 1. Install Node.js from nodejs.org if you don't have it

# 2. Open Terminal/Command Prompt in this folder

# 3. Install dependencies
npm install

# 4. Create your .env file
cp .env.example .env
# Then open .env and add your real API key

# 5. Start the server
npm start

# 6. Open your browser at:
http://localhost:3000
```

---

## Costs

| Item | Cost |
|------|------|
| Railway hosting (beta) | Free (500 hours/month free tier) |
| Render hosting (beta) | Free |
| Anthropic API per session | ~£0.02–0.05 per full session |
| 10 beta testers × 3 sessions each | ~£0.60–1.50 total |

---

## Sharing with Beta Testers

Once deployed, share the URL directly.

Example message:
> "Here is your link to WIZ — your Mind Flow coaching session:
> [your-railway-url]
> 
> Just click, and WIZ will greet you. No login needed for the beta.
> The session takes about 30–40 minutes.
> Your personal report will appear at the end."

---

## Monitoring Sessions

To see a summary of all beta sessions, visit:
```
https://your-railway-url/api/sessions
```
With the header `x-admin-key: your-admin-key-here`

Or simply use curl:
```bash
curl https://your-url/api/sessions -H "x-admin-key: your-admin-key"
```

---

## Security Notes

- Your Anthropic API key is stored only on the server — never visible to users
- Rate limiting: each IP is limited to 50 messages/hour (generous for coaching)
- Sessions are logged in memory during beta — they reset when the server restarts
- For full production: add a database (PostgreSQL) to persist session logs

---

## Next Steps After Beta

1. Collect feedback from all 10 testers
2. Review session logs via `/api/sessions`
3. Share feedback with Claude to refine WIZ's responses
4. Add ElevenLabs voice layer (VAPI integration)
5. Add Stripe payment gate for subscription
6. Lock down `ALLOWED_ORIGIN` to `https://mindflowpro.com`

---

**Support**: share any technical questions with Claude in your coaching platform conversation.

*WIZ — Mind Flow International Ltd © PJ Wingfield 2026*
