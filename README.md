# Schedule Share

Sign up with a name and password, upload your class schedule (screenshot or a
Google Calendar `.ics` export), and compare daily or weekly timetables
side-by-side with classmates who share back.

## Stack

- **Next.js (App Router)** — UI and the `/api/parse-schedule` route.
- **Firebase Auth** — name+password sign-in (a synthetic email is derived from
  the name under the hood; Firebase handles password storage/hashing).
- **Firestore** — accounts, schedules, share edges, notifications, nicknames.
- **Gemini API** — reads a schedule screenshot into structured class times on
  the server (`app/api/parse-schedule/route.js`); `.ics` files are parsed
  entirely client-side, no API call needed.

## One-time setup

1. **Create a Firebase project** at https://console.firebase.google.com.
   - Build → Authentication → get started → enable the **Email/Password** sign-in provider.
   - Build → Firestore Database → create database (start in production mode; the rules in `firestore.rules` lock it down).
   - Project settings → General → "Your apps" → add a **Web app** → copy the config values into `.env.local` as `NEXT_PUBLIC_FIREBASE_*`.
   - Project settings → Service accounts → **Generate new private key** → copy `project_id`, `client_email`, and `private_key` into `.env.local` as `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (keep the `\n`s in the key literal, in quotes).

2. **Gemini API key** — already set in `.env.local` (`GEMINI_API_KEY`). If screenshot parsing ever fails with a model error, check https://ai.google.dev/gemini-api/docs/models for the current free-tier model name and update `GEMINI_MODEL`.

3. **Deploy Firestore security rules** (once the Firebase CLI is installed and logged in):
   ```bash
   npx firebase-tools login
   npx firebase-tools use --add   # pick your project
   npx firebase-tools deploy --only firestore:rules,firestore:indexes
   ```

4. **Run locally**:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. Until the Firebase env vars above are filled in, the app shows a "Firebase isn't configured yet" message instead of the login screen.

## Deploying to Vercel

```bash
npx vercel login
npx vercel link
npx vercel env add NEXT_PUBLIC_FIREBASE_API_KEY production
# ...repeat for every var in .env.local.example...
npx vercel --prod
```

Environment variables are per-Vercel-project and are **not** read from `.env.local` on deploy — each one has to be added via `vercel env add` (or pasted into the Vercel dashboard's Project Settings → Environment Variables) before the first production deploy.
