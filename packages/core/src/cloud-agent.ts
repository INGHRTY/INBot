import type { MessageBlock } from "@rakazo/contracts";

export function cloudAgentHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

function awaitingApprovalFrom(
  value: unknown,
): { approvalId: string; action: string; summary: string; detail?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.approvalId !== "string" ||
    typeof record.action !== "string" ||
    typeof record.summary !== "string"
  )
    return undefined;
  return {
    approvalId: record.approvalId,
    action: record.action,
    summary: record.summary,
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
  };
}

export function cloudAgentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "cloud_agent" }> {
  const status = payload.status;
  return {
    kind: "cloud_agent",
    agentId: String(payload.agentId ?? ""),
    title: String(payload.title ?? "Cloud agent"),
    status:
      status === "finished" || status === "failed" || status === "cancelled" || status === "expired"
        ? status
        : "running",
    url: cloudAgentHttpsUrl(String(payload.url ?? "")) ?? "",
    ...(payload.branch ? { branch: String(payload.branch) } : {}),
    ...(cloudAgentHttpsUrl(String(payload.prUrl ?? "")) ? { prUrl: String(payload.prUrl) } : {}),
    ...(payload.latestRunId ? { latestRunId: String(payload.latestRunId) } : {}),
    ...(payload.result ? { result: String(payload.result) } : {}),
    ...(payload.blockedReason ? { blockedReason: String(payload.blockedReason) } : {}),
    ...(awaitingApprovalFrom(payload.awaitingApproval)
      ? { awaitingApproval: awaitingApprovalFrom(payload.awaitingApproval)! }
      : {}),
  };
}
