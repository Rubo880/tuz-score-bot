# TUZ Leaderboard Bot

Free Telegram leaderboard bot for counting every literal occurrence of the root `туз` or `tuz`.

## Counting

- `ТУЗ`, `ТуЗ`, `tuz`, `TUZ` -> +1
- roots inside longer words count: `растузовка` -> +1
- `tuztuz` -> +2
- `Bluetooth` -> 0
- 3 matches in one message -> +3
- captions on photos/videos count
- edited messages are recalculated

## Commands

- `/setup` — create and pin the live leaderboard
- `/leaderboard` or `/top` — show the current ranking
- `/me` — show your score
- `/rules` — show the counting rules
- `/web` — open the live web leaderboard

## Free architecture

Telegram webhook -> Vercel Functions -> Neon Postgres.

No always-on server is required.

## Environment variables in Vercel

Set these in Project Settings -> Environment Variables:

- `TELEGRAM_BOT_TOKEN` — the NEW BotFather token. Revoke any token ever pasted into a chat.
- `DATABASE_URL` — Neon pooled PostgreSQL connection string.

Do not commit either secret to GitHub.

## First launch

1. In BotFather use `/setprivacy` and Disable privacy for the bot.
2. Add the bot to the Telegram group.
3. Give it permission to Pin Messages if automatic pinning is wanted.
4. Deploy this repository on Vercel after adding the two environment variables.
5. Open `https://YOUR-VERCEL-DOMAIN/api/register` once.
6. Open the bot privately and send `/start`.
7. In the group run `/setup`.

The `/api/register` endpoint configures Telegram's webhook to the current Vercel deployment and installs the bot command menu.
