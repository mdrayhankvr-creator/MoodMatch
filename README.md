# MoodMatch

MoodMatch is a planned semantic, vibe-based movie search application. The repository currently contains the Next.js starter page and the dependency and environment setup for future work. Search, database access, and data ingestion are not implemented yet.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, and Tailwind CSS 4
- Astra DB TypeScript SDK for future vector storage
- OpenAI SDK for future embeddings
- `csv-parser` for future CSV ingestion and `dotenv` for future scripts
- npm for package management

## Install

Use Node.js 22 and npm. From the project root, install the locked dependencies:

```bash
npm ci
```

If `.env.local` does not already exist, copy `.env.example` to `.env.local`, then add your own credentials to the local file. `.env.local` is ignored by Git. The starter page does not use these settings yet.

| Variable | Purpose |
| --- | --- |
| `ASTRA_DB_APPLICATION_TOKEN` | Astra DB application token |
| `ASTRA_DB_API_ENDPOINT` | Astra DB API endpoint |
| `ASTRA_DB_COLLECTION` | Collection name; example uses `movies` |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_EMBEDDING_MODEL` | Embedding model name; example uses `text-embedding-3-small` |

## Local development

```bash
npm run dev
npm run lint
npx tsc --noEmit
```

Open [http://localhost:3000](http://localhost:3000) after starting the development server. In PowerShell environments that block the npm script shim, use `npm.cmd` and `npx.cmd` in place of `npm` and `npx`.
