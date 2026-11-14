-- Servers whose one automatic pick found no channel under the old 3-try rule get one more pick from the hourly run.
UPDATE installs SET auto_channel = NULL
WHERE channel_id IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.guild_id = installs.guild_id);
