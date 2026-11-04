import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, type ConfigStatus } from "./api";

let configEventSource: EventSource | null = null;
let configEventUsers = 0;
let configEventClient: QueryClient | null = null;

/** One shared readiness stream per tab; React Query remains the polling fallback. */
function subscribeConfigStatus(queryClient: QueryClient): () => void {
  configEventUsers += 1;
  configEventClient = queryClient;
  if (!configEventSource && typeof window !== "undefined" && "EventSource" in window) {
    const source = new EventSource("/api/v1/config/status/events");
    configEventSource = source;
    source.addEventListener("status", (event) => {
      try {
        const status = JSON.parse((event as MessageEvent<string>).data) as ConfigStatus;
        configEventClient?.setQueryData(["config-status"], status);
      } catch {
        /* Ignore malformed frames; polling remains the fallback. */
      }
    });
  }
  return () => {
    configEventUsers = Math.max(0, configEventUsers - 1);
    if (configEventUsers === 0 && configEventSource) {
      configEventSource.close();
      configEventSource = null;
      configEventClient = null;
    }
  };
}

/** Live infrastructure status, pushed over SSE and refreshed by polling as a fallback. */
export function useConfigStatus() {
  const queryClient = useQueryClient();
  useEffect(() => subscribeConfigStatus(queryClient), [queryClient]);
  return useQuery({
    queryKey: ["config-status"],
    queryFn: () => api<ConfigStatus>("/config/status"),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
}
