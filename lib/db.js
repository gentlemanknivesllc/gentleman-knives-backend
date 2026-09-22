// lib/db.js
// Thin wrapper around @vercel/postgres so every API route imports the same
// thing. Requires the Vercel Postgres integration to be added to this
// project (Vercel dashboard -> Storage -> Create Database -> Postgres),
// which auto-populates the POSTGRES_URL env vars this library reads.

const { sql } = require('@vercel/postgres');

module.exports = { sql };
