"use client";

import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  PrivySolanaProvider,
  readPublicPrivyAppId,
} from "@/components/providers/privy-provider";
import { UIProvider } from "@/components/providers/ui-provider";

type LiveRootProps = {
  appId: string;
  children: ReactNode;
};

class PrivyLiveErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onFailed: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailed();
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function PrivyLiveGate({
  appId,
  children,
  onReady,
  onFailed,
}: LiveRootProps & { onReady: () => void; onFailed: () => void }) {
  const [LiveRoot, setLiveRoot] = useState<ComponentType<LiveRootProps> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void import("@/components/providers/privy-live-provider")
      .then((mod) => {
        if (cancelled) return;
        setLiveRoot(() => mod.PrivyLiveRoot);
        onReady();
      })
      .catch(() => {
        if (!cancelled) onFailed();
      });
    return () => {
      cancelled = true;
    };
  }, [onFailed, onReady]);

  if (!LiveRoot) {
    return children;
  }

  return (
    <PrivyLiveErrorBoundary fallback={children} onFailed={onFailed}>
      <LiveRoot appId={appId}>{children}</LiveRoot>
    </PrivyLiveErrorBoundary>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const appId = readPublicPrivyAppId();
  const [liveState, setLiveState] = useState<"off" | "pending" | "on" | "failed">(
    appId ? "pending" : "off",
  );
  const onReady = useCallback(() => setLiveState("on"), []);
  const onFailed = useCallback(() => setLiveState("failed"), []);

  return (
    <PrivySolanaProvider pendingLive={liveState === "pending"}>
      <UIProvider>
        {appId ? (
          <PrivyLiveGate
            appId={appId}
            onReady={onReady}
            onFailed={onFailed}
          >
            {children}
          </PrivyLiveGate>
        ) : (
          children
        )}
      </UIProvider>
    </PrivySolanaProvider>
  );
}
