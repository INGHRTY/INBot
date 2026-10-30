-- Additive and nullable: a device task answers with text, and the poller runs in
-- another process than the socket, so the answer has to be stored to be read.
ALTER TABLE "cloud_agents" ADD COLUMN "result" TEXT;
