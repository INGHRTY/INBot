-- Additive and nullable: a task running on someone's computer stops at an action it
-- may not take alone, and the cloud shows that action while the person decides.
ALTER TABLE "cloud_agents" ADD COLUMN "awaitingApproval" JSONB;
