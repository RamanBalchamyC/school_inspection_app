# Tamil Nadu School Inspection

A mobile-friendly school inspection prototype for Tamil Nadu field officers. The React app records school details, academics, infrastructure, sanitation, student follow-up, priority, remarks and photo evidence. Data, sign-in and photos are handled by **Supabase** (Postgres + Auth + Storage). Drafts are saved in the browser, and submissions made offline are queued to sync when connectivity returns.

Officers see only their own reports; admins see all (enforced by Row Level Security in [supabase/schema.sql](supabase/schema.sql)).

## Setup

1. In your Supabase project, open **SQL Editor**, paste [supabase/schema.sql](supabase/schema.sql) and run it.
2. Copy `frontend/.env.example` to `frontend/.env` and fill in your project URL and anon/publishable key (**Project Settings → API**).
3. Run locally:

```powershell
cd frontend
npm install
npm run dev
```

4. Sign up in the app, then make yourself an admin with the `update public.profiles ...` statement at the bottom of `schema.sql`.

## Deploy (Vercel)

Import the repository in Vercel with **Root Directory = `frontend`** (framework preset: Vite), add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables, and deploy. Then set the Vercel URL as the **Site URL** in Supabase → Authentication → URL Configuration.

The `backend/` folder (FastAPI + MySQL) is the original local version and is no longer used.
