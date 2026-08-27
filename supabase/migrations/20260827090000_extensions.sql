-- Extensions.
--
-- On a real Supabase project `vector` and `pgcrypto` live in the `extensions`
-- schema and are usually already installed; `create extension if not exists` is
-- a no-op there. On a plain Postgres used for tests they get created here.

create extension if not exists vector;
create extension if not exists pgcrypto;
