# Learning Analytics Classroom Quiz

A small, self-hosted live quiz based on the 15 questions in `learning_analytics_presentation.html`. The projected instructor page also controls the game; students join and answer on their phones.

## Run it

Requires Node.js 20 or newer. No package installation is needed.

```powershell
cd outputs/learning-analytics-game
npm start
```

Open `http://localhost:3000` on the instructor's computer and project that page. The lobby shows a six-digit room code and a join link. Students can open the link on the same Wi-Fi, or open `/join` on the instructor computer's network address and enter the code.

If students cannot connect, allow Node.js through the computer's firewall on the private classroom network. Keep the server running for the full game.

## Game flow

1. Students enter their name and choose Team 1, Team 2, Team 3, Team 4, Team 5, or Team 6.
2. The instructor starts each question from the projected screen. Students cannot begin the next question themselves.
3. Students choose and submit one answer during the 25-second countdown. The server rejects late or duplicate answers.
4. When the answer timer ends, the projector and phones show the correct answer, explanation, response counts, and team and individual rankings. Results stay visible until the instructor starts the next question.
5. After question 15, the final team and individual rankings appear. The instructor can restart while keeping the roster.

Correct answers earn 500 points plus a speed bonus of up to 500 points. Team scores add each member's points; ties are broken by correct-answer count. Individual rankings use score, then correct-answer count.

## Settings and data

- `PORT` changes the default server port (3000).
- `ANSWER_SECONDS` changes the answer window (25 seconds).

Question text and explanations are in `questions.json`. Rooms and scores are held in memory and are cleared when the server stops. The app does not create student accounts or save a class roster to disk.

## Checks

```powershell
npm test
```
