/**
 * Seed the first admin user.
 *
 * Usage (locally, after `npm install` and setting env vars in .env.local):
 *   npm run seed
 *
 * It reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, generates a bcrypt hash
 * of the initial admin password, and upserts the admin row. Running it twice is
 * safe — it updates the existing 'admin' row rather than creating a duplicate.
 *
 * Credentials come from environment variables — NO password is baked into
 * source (F1). The password is hashed with bcryptjs before it touches the DB;
 * no plaintext is ever stored. Set these before running (e.g. in .env.local):
 *   SEED_ADMIN_PASSWORD   (required, >= 12 chars)
 *   SEED_ADMIN_EMAIL      (optional, defaults to yousef@albaker.qa — not a secret)
 *   SEED_ADMIN_USERNAME   (optional, defaults to 'admin')
 */
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

// Mirror Next.js's env precedence for `next dev` (and scripts/migrate.ts):
// .env.development.local wins over .env.local wins over .env — so running
// this script never accidentally targets .env.local's production database
// when a local dev database is configured.
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'yousef@albaker.qa';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.'
    );
    process.exit(1);
  }

  // F1: fail closed — never seed with a hard-coded/weak default.
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    console.error(
      'SEED_ADMIN_PASSWORD is required and must be at least 12 characters.\n' +
        'Example: SEED_ADMIN_PASSWORD="$(openssl rand -base64 24)" npm run seed'
    );
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const { data, error } = await supabase
    .from('app_users')
    .upsert(
      {
        username: ADMIN_USERNAME,
        email: ADMIN_EMAIL,
        password_hash: passwordHash,
        role: 'admin',
      },
      { onConflict: 'username' }
    )
    .select('id, username, email, role')
    .single();

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }

  console.log('Admin user seeded:', data);
  console.log(`Login with username "${ADMIN_USERNAME}" and the initial password.`);
}

main();
