# optchat-memory

Read [PLAN.md](PLAN.md) for the design and current status, and [README.md](README.md) for commands.

- Run `pnpm quality:offline` before committing. TypeScript is strict (`tsconfig.json`, with
  `erasableSyntaxOnly`); do not loosen `tsconfig*.json` or add `any`.
- Parse untrusted JSON (backend streams, node messages, imports, tool input) with the guards in
  `src/json.ts` and `src/protocol.ts`. Reserve `as` casts for data this code wrote itself, and say
  so in a comment.
- `data/` holds credentials, exports, and live node state. Never commit it, and never move or delete
  files there while the node daemon or a prototype run is using them.
- Keep README.md to how to run things and PLAN.md to design, status, and open issues. Record
  verification in commit messages and tests, not as narrative in the docs.
- Deploying (`cf deploy`) changes the live service the owner uses; do it only when asked.
