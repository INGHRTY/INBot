import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktopModelConnection } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  SwitchField,
} from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * The model a task on this Mac runs with.
 *
 * The key is typed here, written to this Mac's keychain, and never sent to the server:
 * the browser side of the app owns the form, and only this app's main process sees the key.
 */
export function DeviceModelSettings() {
  const { t } = useLingui();
  const models = desktopBridge()?.device?.models;
  const [connections, setConnections] = useState<RakazoDesktopModelConnection[]>([]);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void models?.list().then(setConnections, () => undefined);
  }, [models]);

  async function run(action: () => Promise<RakazoDesktopModelConnection[]>) {
    setPending(true);
    setError(null);
    try {
      setConnections(await action());
      return true;
    } catch {
      setError(t`Could not save the model.`);
      return false;
    } finally {
      setPending(false);
    }
  }

  if (!models) return null;
  return (
    <>
      <SettingsGroup title={<Trans>This Mac's model</Trans>} data-testid="device-models">
        {connections.map((connection) => (
          <SettingsRow
            key={connection.id}
            label={<span dir="auto">{connection.label}</span>}
            control={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Remove ${connection.label}`}
                disabled={pending}
                onClick={() => void run(() => models.remove(connection.id))}
              >
                <Trash2 />
              </Button>
            }
          />
        ))}
        <SettingsRow
          label=""
          control={
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setAdding(true)}>
              <Trans>Add model</Trans>
            </Button>
          }
        />
      </SettingsGroup>
      {error ? <p className="mt-2 px-1 text-[13px] text-destructive">{error}</p> : null}
      <AddModelDialog
        open={adding}
        pending={pending}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setError(null);
        }}
        onSave={async (input) => {
          if (await run(() => models.save(input))) setAdding(false);
        }}
      />
    </>
  );
}

function AddModelDialog({
  open,
  pending,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    provider: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    acceptsImages: boolean;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [acceptsImages, setAcceptsImages] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>
          <Trans>Add model</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>The key is stored on this Mac only.</Trans>
        </DialogDescription>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({
              provider,
              modelId,
              acceptsImages,
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="device-model-provider">
                <Trans>Provider</Trans>
              </FieldLabel>
              <Input
                id="device-model-provider"
                autoComplete="off"
                spellCheck={false}
                placeholder="openai"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-model-id">
                <Trans>Model</Trans>
              </FieldLabel>
              <Input
                id="device-model-id"
                autoComplete="off"
                spellCheck={false}
                placeholder="gpt-5"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-model-key">
                <Trans>API key</Trans>
              </FieldLabel>
              <Input
                id="device-model-key"
                type="password"
                autoComplete="off"
                placeholder={t`Optional for a model on this Mac`}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-model-url">
                <Trans>Server URL</Trans>
              </FieldLabel>
              <Input
                id="device-model-url"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://localhost:11434/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
            <SwitchField
              label={<Trans>Reads screenshots</Trans>}
              checked={acceptsImages}
              onCheckedChange={setAcceptsImages}
            />
          </FieldGroup>
          <Button type="submit" className="mt-4 w-full" disabled={pending || !provider || !modelId}>
            <Trans>Save</Trans>
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
