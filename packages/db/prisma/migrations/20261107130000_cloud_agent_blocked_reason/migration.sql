-- Additive and nullable: a task running on someone's computer reports the last action it
-- refused to take, so the cloud can tell the person why instead of only that it stopped.
ALTER TABLE "cloud_agents" ADD COLUMN "blockedReason" TEXT;
