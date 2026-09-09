# TFT Community Web

Next.js 15 (App Router, TypeScript, Tailwind) foundation for the TFT
Community Platform.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env template and fill in your own Supabase project's values
   (see comments in the file for where to find each key in the Supabase
   dashboard):

   ```bash
   cp .env.example .env.local
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Project structure

- `src/app/` — routes (App Router)
- `src/components/` — shared UI components
- `src/lib/supabase/` — Supabase browser/server client helpers
  (`@supabase/ssr`)
- `supabase/migrations/` — SQL migration files (authored as files only;
  see [supabase/migrations/README.md](supabase/migrations/README.md) for
  current status — no migration here has been applied to any project)

## Learn more

- [Next.js Documentation](https://nextjs.org/docs)
- [Supabase + Next.js (`@supabase/ssr`)](https://supabase.com/docs/guides/auth/server-side/nextjs)
