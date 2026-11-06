import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (set them in frontend/.env or in Vercel).",
  );
}

export const supabase = createClient(url, key);
export const PHOTO_BUCKET = "inspection-photos";
