# OpenAI Malayalam group replies

This feature is optional and does not change the WhatsApp authentication/session code.

## DormHost environment variables

Set these in the DormHost app's Variables tab:

- `OPENAI_API_KEY` — required; paste the secret API key as the value.
- `OPENAI_MODEL` — optional; defaults to `gpt-4o-mini`.
- `AI_REPLY_COOLDOWN_MS` — optional; defaults to 15000 (15 seconds) per sender per group.

Variable names are case-sensitive. The key must never be committed to GitHub or pasted into chat.

## Behavior

- OpenAI replies are generated in Malayalam when the existing group mention logic detects a mention of the configured owner number/name or an all-members mention.
- The private Grill Arabia auto-replies and existing command handling (including `.ping`) are unchanged.
- If the API key is missing, the API request fails, or the cooldown applies, the existing friendly mention reply is used instead.
- API calls use Node.js 20's built-in `fetch`; no extra npm dependency is required.
- The WhatsApp auth directory remains controlled by `SESSION_DIR` (currently `/data/session`). This feature does not read, delete, or rewrite session files.

## Deployment

This branch is prepared for review only. Do not merge it into `main` or deploy it until the owner explicitly approves.
