# Thinkage Triplified

A cooperative three-word chain party game for 3 to 6 players. Everyone plays on their own phone. No accounts.

## Run it on your computer

    npm install
    npm start

Open http://localhost:3000 in several browser tabs (or on phones on the same Wi-Fi using your computer's address) to try it. `npm test` plays full simulated games and checks the scoring.

## Put it online with GitHub and Render

1. Create a new GitHub repository and push this folder to it (leave `node_modules` out; `.gitignore` already does).
2. In Render choose **New > Web Service** and connect that repository. (Or choose **New > Blueprint** and Render reads `render.yaml`.)
3. If you set it up by hand use: Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. When the deploy finishes, open the `onrender.com` address on a phone. One player taps **Start a new game** and shares the four-letter code. Everyone else taps **Join game**.

Render's free tier puts the server to sleep after a while without visitors. The first person to open it afterward waits about a minute. Games are kept in memory, so a restart or redeploy ends any game in progress.

## How the game plays

- **Link.** Each player is secretly given one word from a lettered list (14 words for 3 or 4 players, 16 for 5 or 6). That word must be in their chain. They pick two more words, put the three in order, and type two link words: word 1 - link 1 - word 2 - link 2 - word 3.
- **Think.** Everyone sees each other player's two link words in the order entered, with blanks: `<blank> Drive <blank> Breakfast <blank>`. Guessers fill the blanks in order, can switch between players, and can leave blanks empty.
- **One clock.** 3:00 (3 players), 3:30 (4), 4:00 (5), 4:30 (6) covering both phases. If time runs out during Link there is no Think phase and the round scores 0. In Think, locked or filled guesses count.
- **Scoring (per guess).** 2 slots right +2, all 3 right +5, 0 or 1 right 0. A star doubles a scoring guess; a starred guess that scores nothing costs 2.
- **Same chain.** If two players end up with the same three words in the same order, or in exactly the reverse order (A-B-C and C-B-A), the other players vote on whether the link words were the same (swapped places count as the same when reversed; tie = different). Same: nobody scores it and stars cost nothing. Different: each guesser scores once, using the best result. Any other reordering counts as a different chain.
- **Team result.** Perfect game = every guesser getting every chain fully right in all 3 rounds (n x (n-1) x 3 x 5), plus 25% for stars. Bands: 90%+ Excellent, 80-89 Good, 70-79 OK, 60-69 Satisfactory, 50-59 "Were you really trying?", under 50 "Not good! Better luck next time."

## Tuning

All numbers are constants at the top of `server.js`: `ROUND_SECONDS`, `WORD_COUNT`, `SCORE_BY_SLOTS`, `STAR_MULTIPLIER`, `STAR_MISS_PENALTY`, `MIN_WORDS`. Word lists live in `words.js` (each list needs at least 48 words).
