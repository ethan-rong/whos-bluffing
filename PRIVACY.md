# Privacy

Who's Bluffing is an independent, unaffiliated, non-commercial project. No accounts, no advertising, no tracking scripts, no sale of data.

## Web (rounds, daily game and full assessment)

**Daily game:** each completed play stores your anonymous id, the UTC date, which surface you played on (web, Slack, classroom), your five ranges, whether each contained the truth, response times, and the day's score. The anonymous id lives in your browser's local storage so your streak and personal calibration curve persist; clearing site data resets it. Flagging a question stores your anonymous id with the flag so each person counts once.

**Rounds:** each answer is stored as soon as you choose a confidence, even if you stop before the end: your anonymous id, the round id, the question id, your choice, your confidence, whether it was right and its points, the response time, the time, the surface (web, Slack, Discord or a room) and, outside the web, the community (a hashed workspace or server id, or the room code). A Slack or Discord answer to the daily question is stored the same way; whether it was right and its points are filled in at the reveal. A completed round adds one record with the same ids, your score, accuracy, average confidence, overconfidence, Brier score and type, the time, a random public token for your challenge link (never your anonymous id), the challenger's token if you started from someone's challenge link, and the nickname you typed for challenge links, if you typed one. That nickname is shown to anyone who opens your challenge link, on the page and in its link preview. Each day you play stores how many rounds you finished and your streak, with your anonymous id. Share, challenge-page and play-again counts are kept per day with no id at all. Flagging a question stores your anonymous id, the question id and the reason you typed, if any. A dare round stores the same as any round; the page shows only the named person's public status. Your browser keeps the round in progress, the questions you have seen, the dares you have finished, your nickname and your challenge links in its local storage. It also keeps your last 10 completed round results, including their questions, answers, scores and completion dates, so you can reopen them from Recent games. This list stays in that browser; clearing site data removes it. Reopening a saved result does not submit another completed play.

**Lab claims:** after a round in the AI pack you can say which lab you are with (OpenAI, Anthropic, Google, xAI, Meta or Other). Nobody checks it. A claim stores one record per round: the lab, the round id, the day you finished the round, its difficulty, your score and overconfidence in it, and the time of the claim; picking another lab for the same round replaces the lab. It stores nothing else: not your anonymous id, though the round id links the claim to your completed round. Your browser keeps the lab in its local storage, so later AI rounds are claimed for you until you change it or clear site data. The public board shows only totals per lab, and averages only once a lab has 10 claims. After a round in the Politics pack you can say which side you are on (Democrats, Republicans, Independents or No side) in the same way: it is stored, kept in your browser and shown exactly like a lab claim, on the board at /parties.

**Full assessment — what is stored when you finish:** your answers and confidence ratings, how long each question took, the language of the test, the two-letter country code supplied by our hosting provider (never your IP address), the optional demographic answers you choose to give (age band, education, native language, region), a random session identifier, and a class code if you entered one. Nothing is stored if you close the page before the end.

**What is never stored:** IP address, browser fingerprint, device identifiers, cookies for tracking, names (apart from a nickname you choose for a challenge link or the display name you agree to share when joining a Slack or Discord group round), emails.

**Repeat visits:** your browser keeps a random id (not linked to you) so that later sessions from the same browser can be tied together. This is what makes streaks and the practice-effect analysis possible, and it lets the research analysis keep only one full assessment per browser. Clearing site data removes it.

**What it is used for:** the results page you see, aggregate statistics on the public stats page, and a public research dataset. Row-level data is anonymous and will be released openly.

**Classroom mode:** an instructor who creates a class code sees only aggregates for that class, never individual rows, and sees nothing until at least 5 students have finished.

**Slack and Discord:** the chat apps store, per workspace or server, its id, the chosen channel, the bot token, the posting hour, the roast-mode setting, the ids of the messages they posted, and each day's answers (choice, confidence, points, right or wrong) keyed by a salted hash of the member id. They do not store member messages, raw member ids or emails. Daily leaderboards and recaps fetch display names from the platform while drawing them. With roast mode off (the default) nobody is named next to a wrong daily answer.

**Private chat rounds:** the apps temporarily keep your selected topic and difficulty, questions, progress, score and challenge link so you can finish a round, recover from a failed response or play again. These records use your salted member hash and the chat scope, not your raw member id. Slack rounds expire one hour after creation; Discord solo rounds expire after one hour without activity. Expired records are removed on the next cleanup pass. Anonymous answers and completed scores remain with the game server under the rounds policy above.

**Discord group rounds:** pressing Join agrees to share your Discord display name and final score with that chat. Your individual answers stay in your private game response. The app temporarily stores the group round, its chat scope, your salted member hash, display name, progress and completed score. Group sessions expire one hour after creation and their temporary records are removed on the next cleanup pass. Names from these sessions are not sent to the research API or included in research data. A score already posted in Discord can remain there after the app's temporary record expires. In direct messages and group DMs, anonymous player ids are scoped to that chat; the research API receives no raw chat id and does not count the chat as a server. Personal app installation does not enable scheduled server posts.

**Slack group rounds:** pressing Join agrees to share your Slack display name and final score in that channel. Individual answers stay in your private game response. The app temporarily stores the group round, hashed chat scope, salted member hash, display name, progress and completed score. Sessions expire one hour after creation and their temporary records are removed on the next cleanup pass. Group display names are not sent to the research API. A score already posted in Slack can remain there after the app's temporary record expires. Installing the app or playing a group round does not enable scheduled daily questions; a member must configure a channel separately.

**Player counts:** the public status page shows Total Players, counted from anonymous ids. Daily active players, MAU (rolling 30 days) and annual activity (rolling 365 days) are available only to the project owner.

**Retention:** indefinitely, as anonymous research data.

**Opting out:** do not press Submit, or close the page. Because sessions carry no identifier linked to you, we cannot locate a specific session afterwards to delete it.

- **Home page panel.** The home page shows, for the current day, a calibration chart built from everyone's answers and up to three of the day's costliest confident misses (the question, the wrong pick, the stake and the points). These are aggregates: no name, id or link to any player is shown or stored for this purpose.

## Contact

Open an issue on the GitHub repository.
