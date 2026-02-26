require('dotenv').config();
const pool = require('./db');

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" VARCHAR NOT NULL PRIMARY KEY,
      "sess" JSON NOT NULL,
      "expire" TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

    CREATE TABLE IF NOT EXISTS "users" (
      "id" SERIAL PRIMARY KEY,
      "first_name" VARCHAR(100) NOT NULL,
      "last_name" VARCHAR(100) NOT NULL,
      "company_name" VARCHAR(200),
      "email" VARCHAR(255) NOT NULL UNIQUE,
      "password_hash" VARCHAR(255) NOT NULL,
      "ebay_token" TEXT,
      "google_vision_key" TEXT,
      "openai_api_key" TEXT,
      "openai_model" VARCHAR(50) DEFAULT 'gpt-5.2',
      "ebay_client_id" TEXT,
      "ebay_client_secret" TEXT,
      "example_template" TEXT,
      "role" VARCHAR(20) NOT NULL DEFAULT 'admin',
      "account_id" INTEGER REFERENCES "users"("id"),
      "created_at" TIMESTAMP DEFAULT NOW(),
      "updated_at" TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS "listings" (
      "id" SERIAL PRIMARY KEY,
      "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "ebay_item_id" VARCHAR(50) NOT NULL,
      "title" VARCHAR(100) NOT NULL,
      "price" NUMERIC(10,2) NOT NULL,
      "thumbnail_url" TEXT,
      "category_id" VARCHAR(20),
      "condition_id" VARCHAR(10),
      "account_id" INTEGER REFERENCES "users"("id"),
      "created_at" TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_listings_user_id" ON "listings" ("user_id");

    CREATE TABLE IF NOT EXISTS "drafts" (
      "id" SERIAL PRIMARY KEY,
      "account_id" INTEGER NOT NULL REFERENCES "users"("id"),
      "created_by" INTEGER NOT NULL REFERENCES "users"("id"),
      "product_name" VARCHAR(255) NOT NULL,
      "brand" VARCHAR(255),
      "confidence" INTEGER DEFAULT 0,
      "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
      "generated_title" VARCHAR(100),
      "generated_html" TEXT,
      "category_id" VARCHAR(20),
      "category_name" VARCHAR(255),
      "suggested_brand" VARCHAR(255),
      "suggested_type" VARCHAR(255),
      "suggested_mpn" VARCHAR(255),
      "item_aspects" JSONB,
      "sku" VARCHAR(100),
      "price" NUMERIC(10,2),
      "condition_id" VARCHAR(10),
      "quantity" INTEGER DEFAULT 1,
      "shipping_policy_id" VARCHAR(50),
      "return_policy_id" VARCHAR(50),
      "best_offer_enabled" BOOLEAN DEFAULT false,
      "auto_accept_price" NUMERIC(10,2),
      "min_best_offer_price" NUMERIC(10,2),
      "auto_pay" BOOLEAN DEFAULT true,
      "claude_verified" BOOLEAN DEFAULT false,
      "ebay_item_id" VARCHAR(50),
      "price_range" JSONB,
      "created_at" TIMESTAMP DEFAULT NOW(),
      "updated_at" TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_drafts_account_id" ON "drafts" ("account_id");

    CREATE TABLE IF NOT EXISTS "draft_images" (
      "id" SERIAL PRIMARY KEY,
      "draft_id" INTEGER NOT NULL REFERENCES "drafts"("id") ON DELETE CASCADE,
      "image_index" INTEGER NOT NULL DEFAULT 0,
      "base64_data" TEXT NOT NULL,
      "filename" VARCHAR(255),
      "mime_type" VARCHAR(50),
      "created_at" TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_draft_images_draft_id" ON "draft_images" ("draft_id");

    CREATE TABLE IF NOT EXISTS "password_reset_codes" (
      "id" SERIAL PRIMARY KEY,
      "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "code" VARCHAR(6) NOT NULL,
      "expires_at" TIMESTAMP NOT NULL,
      "used" BOOLEAN DEFAULT false,
      "created_at" TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_reset_codes_user_id" ON "password_reset_codes" ("user_id");
    CREATE INDEX IF NOT EXISTS "IDX_reset_codes_expires" ON "password_reset_codes" ("expires_at");
  `);

  // Add columns that may not exist on older installations
  const migrations = [
    `ALTER TABLE "users" RENAME COLUMN "username" TO "email"`,
    `ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(255)`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "example_template" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" VARCHAR(20) NOT NULL DEFAULT 'admin'`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_id" INTEGER REFERENCES "users"("id")`,
    `UPDATE "users" SET account_id = id WHERE account_id IS NULL`,
    `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "account_id" INTEGER REFERENCES "users"("id")`,
    `UPDATE "listings" SET account_id = user_id WHERE account_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS "IDX_listings_account_id" ON "listings" ("account_id")`,
    `CREATE INDEX IF NOT EXISTS "IDX_users_account_id" ON "users" ("account_id")`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { /* column may already exist */ }
  }

  console.log('Database tables created successfully.');
  await pool.end();
}

setup().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
