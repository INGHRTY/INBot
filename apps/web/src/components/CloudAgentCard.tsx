import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";

export function CloudAgentCard({
  block,
  onAnswer,
}: {
  block: Extract<MessageBlock, { kind: "cloud_agent" }>;
  /** Answers the action the task is waiting on. Absent on a card nobody may answer. */
  onAnswer?: (allowed: boolean) => void;
}) {
  const prHref = cloudAgentHttpsUrl(block.prUrl);
  const href = prHref ?? cloudAgentHttpsUrl(block.url);
  const content = (
    <Card size="sm" className="w-80 max-w-full" data-testid="cloud-agent-card">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium" dir="auto">
            {block.title}
          </span>
          <Badge
            variant="secondary"
            className={
              block.status === "failed"
                ? "text-destructive"
                : block.status === "finished"
                  ? "text-success"
                  : "text-muted-foreground"
            }
          >
            {block.status === "running" ? (
              <Trans>running</Trans>
            ) : block.status === "finished" ? (
              <Trans>finished</Trans>
            ) : block.status === "cancelled" ? (
              <Trans>cancelled</Trans>
            ) : block.status === "expired" ? (
              <Trans>expired</Trans>
            ) : (
              <Trans>failed</Trans>
            )}
          </Badge>
        </div>
        {prHref ? (
          <span className="text-muted-foreground">
            <Trans>Pull request</Trans>
          </span>
        ) : block.branch ? (
          <span className="text-muted-foreground" dir="auto">
            {block.branch}
          </span>
        ) : null}
        {block.awaitingApproval ? (
          <div className="flex flex-col gap-1" data-testid="cloud-agent-awaiting">
            <span className="text-muted-foreground" dir="auto">
              {block.awaitingApproval.summary}
            </span>
            {block.awaitingApproval.detail ? (
              <span
                className="rounded-sm bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
                dir="auto"
              >
                {block.awaitingApproval.detail}
              </span>
            ) : null}
            {onAnswer ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onAnswer(true)}>
                  <Trans>Allow once</Trans>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>
                  <Trans>Deny</Trans>
                </Button>
              </div>
            ) : null}
          </div>
        ) : block.result ? (
          <span className="text-muted-foreground whitespace-pre-wrap" dir="auto">
            {block.result}
          </span>
        ) : null}
        {block.blockedReason ? (
          <span className="text-muted-foreground" dir="auto">
            {block.blockedReason}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block max-w-full no-underline">
      {content}
    </a>
  ) : (
    content
  );
}
