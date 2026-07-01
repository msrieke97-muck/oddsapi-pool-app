# Weekly Sports Pool — The Odds API

This replaces the Balldontlie integration with **The Odds API**.

## Admin token

```text
PbvAvcPld9mIZYKL3JZnBWOo0jl4sI7gLrjOUXiegpiy9fdR
```

## Local run

```bash
npm i
cp .env.example .env
npm start
```

Open:

```text
User form:
http://localhost:8080/pool.html?sport=soccer_fifa_world_cup

Admin:
http://localhost:8080/admin?token=PbvAvcPld9mIZYKL3JZnBWOo0jl4sI7gLrjOUXiegpiy9fdR
```

## Supported starting sport keys

The app already includes profiles for:

```text
soccer_fifa_world_cup
americanfootball_nfl
americanfootball_ncaaf
basketball_nba
icehockey_nhl
baseball_mlb
soccer_usa_mls
```

Use a different sport in the URL:

```text
http://localhost:8080/pool.html?sport=americanfootball_nfl
http://localhost:8080/admin?token=PbvAvcPld9mIZYKL3JZnBWOo0jl4sI7gLrjOUXiegpiy9fdR&sport=americanfootball_nfl
```

## What it generates

For the selected sport/week:

- 3 closest moneyline/head-to-head markets (`h2h`)
- 3 closest spreads (`spreads`)
- 3 totals (`totals`)
- $20 buy-in
- minimum 5% admin fee
- default payout split 70/20/10

## Notes

The app caches each generated slate in `data/slates`. Regenerating a slate consumes Odds API credits, so use the admin regenerate button only when needed.

The app has fallback lines if a sport/event does not provide all markets, but the best experience is when The Odds API returns h2h, spreads, and totals.


## Submissions troubleshooting

The admin dashboard has two submission views:

1. **Leaderboard** — entries for the currently selected/generated pool only.
2. **All Saved Submissions** — every saved entry for the selected sport, including older pools.

If you regenerate a pool after users submit, the old entries remain saved but may not appear on the active leaderboard because they belong to the previous `pool_id`.

If you deploy on a free host with ephemeral storage, entries can disappear after a redeploy/restart unless you connect persistent storage or a database.


## Admin loading troubleshooting

The admin dashboard now has a visible status/error area and a **Saved Slates** section.

If picks/pools do not load, check:

1. `ODDS_API_KEY` exists in Render/local `.env`.
2. The Odds API free credits are not exhausted.
3. The selected sport has upcoming events and odds.
4. You have clicked **Regenerate Slate** at least once.
5. You are checking the same deployed domain where users submitted entries.

The dashboard uses `/api/admin/current-or-latest` so it can show the latest saved pool even if a fresh Odds API request fails.
