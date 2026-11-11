# Gloss

An iPhone web app (Safari, static, no backend). `PLAN.md` is the spec: read it
in full before writing code, work one phase at a time, and stop at the end of
each phase for the owner to confirm. `DECISIONS.md` records choices and which
third-party details are still unverified. Keep both and `README.md` current.

- Do not trust memory for Soniox, the Anthropic SDK or iOS Safari behaviour;
  read the docs and note in `DECISIONS.md` what was read and what could not be.
- Only the owner can test on the real iPhone. Headless Chromium passing is not
  the same thing; say which one a claim rests on.
- Checks: `npm run typecheck`, `npm test`, `npm run build`.
- No audio, transcripts of real calls, or API keys in git.
