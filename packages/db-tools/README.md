# @qwikbuild/qbsdk-db-tools

Database migration and seeding tools for QwikBuild projects. Runs SQL migrations using psql and syncs schema with drizzle-kit.

## Installation

```bash
# From GitHub release
npm install https://github.com/snowmountainAi/qbsdk/releases/download/db-tools-v1.0.0/qbsdk-db-tools-1.0.0.tgz

# Or add to package.json
"@qwikbuild/qbsdk-db-tools": "https://github.com/snowmountainAi/qbsdk/releases/download/db-tools-v1.0.0/qbsdk-db-tools-1.0.0.tgz"
```

## Commands

### qb-db-migrate

Runs SQL migrations from `backend/migrations/` directory.

```bash
npx qb-db-migrate
```

**What it does:**
1. Creates `_migrations` tracking table if not exists
2. Applies pending `.sql` files in order
3. Records applied migrations
4. Runs `drizzle-kit pull` to sync TypeScript schema

### qb-db-seed

Seeds the database with data from a SQL file.

```bash
# With explicit file
npx qb-db-seed ./backend/seed-data.sql

# Auto-detect (looks for backend/seed-data.sql, backend/seed.sql, etc.)
npx qb-db-seed
```

### qb-db-pull

Pulls database schema into TypeScript using drizzle-kit.

```bash
npx qb-db-pull
```

## Requirements

- Node.js >= 18
- PostgreSQL (`psql` and `pg_dump` in PATH)
- `DATABASE_URL` environment variable set
- `drizzle-kit` installed in project (for schema sync)

## Project Structure Expected

```
project/
├── .env                 # DATABASE_URL here
├── backend/
│   ├── drizzle.config.ts
│   ├── migrations/
│   │   ├── 0000_initial.sql
│   │   └── 0001_add_users.sql
│   └── seed-data.sql    # Optional
└── package.json
```

## License

Apache-2.0
