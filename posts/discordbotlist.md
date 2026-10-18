# discordbotlist.com listing (also reuse for discords.com)

Submit Sun Oct 4 with top.gg. Field names and limits on both sites are unverified: if a field is shorter, cut from the
end of the long description. Replace `1556371051439587461` and `https://discord.gg/V5wcSC7cd`. Ask for votes on top.gg only, so votes are
not split. Claims that must stay true: "source published" (repo public from Mon Oct 5); the data "will be released".

## Fields

- Prefix: `/`
- Invite: `https://discord.com/oauth2/authorize?client_id=1556371051439587461&scope=bot+applications.commands&permissions=83968&integration_type=0`
- Website: `https://whosbluffing.com/discord`
- Support server: `https://discord.gg/V5wcSC7cd`
- GitHub: `https://github.com/ethan-rong/whos-bluffing` (`ethan-rong` if you skipped the username change in `USER_TODO.md` B1)
- Tags (pick from their list): Fun · Games · Social · Education

## Short description (99 characters)

Smarter than your server? One question a day: pick A or B, say how sure, and see who's bluffing.

## Long description (Markdown)

**One question a day that gets your server talking.**

Who's Bluffing posts one question a day in your channel: "Which is longer: the Nile or the Danube?" Tap A or B, then
say how sure you are, from 50% to 100%. At reveal time the post shows the answer with its sources, how your server
split, today's top 5 and the bluff of the day.

**Bluffing costs points:** 50% scores 0; 100% scores +100 if you are right and −300 if you are wrong.

- `/bluff setup` channel, hour and roast mode (Manage Server)
- `/bluff question` post today's question now
- `/bluff play` a private 10-question round with a Challenge button
- `/bluff stats` the 30-day leaderboard
- `/bluff help` · `/bluff invite`

Roast mode (off by default) names the day's biggest bluffer. A recap arrives every Monday. No messages, usernames or
user ids are stored with answers. Free, independent, no ads, no accounts. Source published for transparency.

## Note to reviewers (if the form has one)

HTTP-only bot: it never connects to the gateway, so it shows no online status or presence, but every command works. Type `/bluff help` in any text channel for an instant reply, then `/bluff play` for a private round.
