import Link from "next/link";
import { Button } from "@/components/ui/button";

export function CopyButton({
  signalId,
  enabled,
  label = "Copy now",
}: {
  signalId: string | null;
  enabled: boolean;
  label?: string;
}) {
  if (!enabled || !signalId) {
    return (
      <Button size="sm" disabled>
        Not on allowlist
      </Button>
    );
  }

  return (
    <Button
      nativeButton={false}
      size="sm"
      render={<Link href={`/trade/${signalId}?copy=1`} />}
    >
      {label}
    </Button>
  );
}
