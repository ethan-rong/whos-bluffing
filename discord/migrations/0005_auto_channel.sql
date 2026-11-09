-- The daily question starts without /bluff setup: the channel that takes the install hello becomes the daily channel.
-- Each server gets that pick once: at its install event, or, for servers added before this, from the hourly run.
ALTER TABLE installs ADD COLUMN auto_channel TEXT;  -- when the server had its one automatic channel pick
