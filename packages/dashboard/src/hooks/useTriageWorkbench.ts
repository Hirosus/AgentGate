"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KNOWN_SERVICES,
  TRIAGE_PRESETS,
  type EngineMode,
  type FaultMode,
  type TriageApiResponse,
  type TriagePreset,
} from "@/lib/triageCatalog";
import {
  WEBHOOK_LIBRARY_ITEMS,
  buildPresetInitialPreview,
  buildTriagePreview,
  computeTimingPhaseWaterfall,
  formatPythonSdkSnippet,
  formatSignedCurlCommand,
  getServiceSlaInfo,
  type WebhookLibraryItem,
  type WebhookProviderId,
} from "@/lib/triagePreview";

export interface LiveTriagePresetRequest {
  readonly presetId: string;
  readonly nonce: number;
}

export interface LiveTriageCustomRequest {
  readonly nonce: number;
  readonly service: string;
  readonly p95Ms: number | null;
  readonly payloadText: string;
}

export interface StreamDeliveryEntry {
  readonly id: string;
  readonly timestampLabel: string;
  readonly isLiveDispatched: boolean;
  readonly providerId: WebhookProviderId;
  readonly providerLabel: string;
  readonly eventType: string;
  readonly pathname: string;
  readonly service: string;
  readonly p95Ms: number;
  readonly payloadText: string;
  readonly fault: FaultMode;
  readonly mode: EngineMode;
  readonly idempotencyKey: string;
  readonly response: TriageApiResponse;
}

export type StatusFilter = "all" | "accepted" | "duplicate" | "rejected" | "bait";

/** Discriminated union preventing impossible async/feedback UI states. */
export type DispatchBannerState =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching"; readonly targetService: string }
  | { readonly kind: "resetting" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "notice"; readonly message: string };

export function generateFreshKey(service: string): string {
  const clean = service.replace(/[^a-z0-9-]/gi, "").slice(0, 20) || "svc";
  const rand = Math.random().toString(36).slice(2, 7);
  return `evt-${clean}-${rand}`;
}

export function formatTriageMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) {
    return "-";
  }
  if (ms < 100 && !Number.isInteger(ms)) {
    return `${ms.toFixed(1)} ms`;
  }
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

function buildSeededStreamEntries(
  liveAiConfigured: boolean,
): ReadonlyArray<StreamDeliveryEntry> {
  const seeds: ReadonlyArray<{
    readonly item: WebhookLibraryItem;
    readonly fault: FaultMode;
    readonly timeLabel: string;
    readonly keySuffix: string;
  }> = [
    { item: WEBHOOK_LIBRARY_ITEMS[0]!, fault: "valid", timeLabel: "13:52:40", keySuffix: "demo" },
    { item: WEBHOOK_LIBRARY_ITEMS[1]!, fault: "valid", timeLabel: "13:52:18", keySuffix: "skew01" },
    { item: WEBHOOK_LIBRARY_ITEMS[0]!, fault: "duplicate_replay", timeLabel: "13:51:54", keySuffix: "dup01" },
    { item: WEBHOOK_LIBRARY_ITEMS[2]!, fault: "valid", timeLabel: "13:51:12", keySuffix: "tls01" },
    { item: WEBHOOK_LIBRARY_ITEMS[3]!, fault: "valid", timeLabel: "13:50:49", keySuffix: "bait01" },
    { item: WEBHOOK_LIBRARY_ITEMS[1]!, fault: "tamper_body", timeLabel: "13:50:05", keySuffix: "tamper01" },
    { item: WEBHOOK_LIBRARY_ITEMS[4]!, fault: "valid", timeLabel: "13:49:22", keySuffix: "redis01" },
    { item: WEBHOOK_LIBRARY_ITEMS[5]!, fault: "stale_timestamp", timeLabel: "13:48:30", keySuffix: "stale01" },
  ];

  return seeds.map((cfg, index) => {
    const idempotencyKey =
      index === 0
        ? `evt-${cfg.item.service}-demo`
        : `evt-${cfg.item.service}-${cfg.keySuffix}`;
    return {
      id: `seed-${index}-${cfg.keySuffix}`,
      timestampLabel: cfg.timeLabel,
      isLiveDispatched: false,
      providerId: cfg.item.providerId,
      providerLabel: cfg.item.providerLabel,
      eventType: cfg.item.eventType,
      pathname: cfg.item.pathname,
      service: cfg.item.service,
      p95Ms: cfg.item.p95Ms,
      payloadText: cfg.item.payloadText,
      fault: cfg.fault,
      mode: "deterministic_mcp",
      idempotencyKey,
      response: buildTriagePreview({
        service: cfg.item.service,
        p95Ms: cfg.item.p95Ms,
        payloadText: cfg.item.payloadText,
        idempotencyKey,
        fault: cfg.fault,
        mode: "deterministic_mcp",
        liveAiConfigured,
        claimedKeyCount: 0,
      }),
    };
  });
}

export function useTriageWorkbench(opts: {
  readonly presetRequest?: LiveTriagePresetRequest | null;
  readonly customRequest?: LiveTriageCustomRequest | null;
  readonly onStatusSync?: (status: {
    readonly liveAiConfigured: boolean;
    readonly claimedKeyCount: number;
  }) => void;
}) {
  const defaultPreset: TriagePreset = TRIAGE_PRESETS[0]!;
  const [providerFilter, setProviderFilter] = useState<WebhookProviderId | "all">("all");
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>(WEBHOOK_LIBRARY_ITEMS[0]!.id);
  const [service, setService] = useState<string>(defaultPreset.service);
  const [p95Input, setP95Input] = useState<string>(String(defaultPreset.p95Ms ?? 820));
  const [payloadText, setPayloadText] = useState<string>(defaultPreset.payloadText);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(`evt-${defaultPreset.service}-demo`);
  const [fault, setFault] = useState<FaultMode>("valid");
  const [mode, setMode] = useState<EngineMode>("deterministic_mcp");

  const [libraryDrawerOpen, setLibraryDrawerOpen] = useState<boolean>(false);
  const [libraryTab, setLibraryTab] = useState<"library" | "custom">("library");
  const [liveAiConfigured, setLiveAiConfigured] = useState<boolean>(false);
  const [claimedKeyCount, setClaimedKeyCount] = useState<number>(0);
  const [liveDispatchedEntries, setLiveDispatchedEntries] = useState<
    ReadonlyArray<StreamDeliveryEntry>
  >([]);
  const [selectedStreamId, setSelectedStreamId] = useState<string>("active-preview");
  const [bannerState, setBannerState] = useState<DispatchBannerState>({ kind: "idle" });
  const [showFacetSidebar, setShowFacetSidebar] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [serviceFilter, setServiceFilter] = useState<string>("all");
  const [streamSearch, setStreamSearch] = useState<string>("");
  const [originUrl, setOriginUrl] = useState<string>("http://127.0.0.1:8000");

  useEffect(() => {
    if (typeof window !== "undefined" && window.location?.origin) {
      setOriginUrl(window.location.origin);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/triage", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { liveAiConfigured?: boolean; claimedKeyCount?: number } | null) => {
        if (cancelled || !data) return;
        setLiveAiConfigured(Boolean(data.liveAiConfigured));
        if (typeof data.claimedKeyCount === "number") {
          setClaimedKeyCount(data.claimedKeyCount);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    opts.onStatusSync?.({ liveAiConfigured, claimedKeyCount });
  }, [claimedKeyCount, liveAiConfigured, opts]);

  useEffect(() => {
    if (!opts.presetRequest) return;
    const preset =
      TRIAGE_PRESETS.find((p) => p.id === opts.presetRequest?.presetId) ?? TRIAGE_PRESETS[0]!;
    setService(preset.service);
    setP95Input(String(preset.p95Ms ?? 115));
    setPayloadText(preset.payloadText);
    setFault("valid");
    setIdempotencyKey(
      preset.id === TRIAGE_PRESETS[0]!.id
        ? `evt-${preset.service}-demo`
        : generateFreshKey(preset.service),
    );
    setSelectedStreamId("active-preview");
    setBannerState({ kind: "notice", message: `Loaded monitor "${preset.label}" into webhook gate.` });
  }, [opts.presetRequest]);

  useEffect(() => {
    if (!opts.customRequest) return;
    setService(opts.customRequest.service);
    setP95Input(String(opts.customRequest.p95Ms ?? 250));
    setPayloadText(opts.customRequest.payloadText);
    setFault("valid");
    setIdempotencyKey(generateFreshKey(opts.customRequest.service));
    setSelectedStreamId("active-preview");
    setBannerState({
      kind: "notice",
      message: `Loaded scenario for "${opts.customRequest.service}" into webhook gate.`,
    });
  }, [opts.customRequest]);

  const parsedP95 = useMemo(() => {
    const num = Number(p95Input);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  }, [p95Input]);

  const activeLibraryItem = useMemo(
    () => WEBHOOK_LIBRARY_ITEMS.find((i) => i.id === selectedLibraryId) ?? WEBHOOK_LIBRARY_ITEMS[0]!,
    [selectedLibraryId],
  );

  const activePreviewResponse = useMemo<TriageApiResponse>(() => {
    if (
      service === defaultPreset.service &&
      parsedP95 === defaultPreset.p95Ms &&
      payloadText === defaultPreset.payloadText &&
      fault === "valid" &&
      mode === "deterministic_mcp" &&
      idempotencyKey === `evt-${defaultPreset.service}-demo`
    ) {
      const initial = buildPresetInitialPreview(defaultPreset);
      return { ...initial, claimedKeyCount, liveAiConfigured } as TriageApiResponse;
    }
    return buildTriagePreview({
      service,
      p95Ms: parsedP95,
      payloadText,
      idempotencyKey,
      fault,
      mode,
      liveAiConfigured,
      claimedKeyCount,
    });
  }, [claimedKeyCount, defaultPreset, fault, idempotencyKey, liveAiConfigured, mode, parsedP95, payloadText, service]);

  const activePreviewEntry = useMemo<StreamDeliveryEntry>(() => {
    const matched = WEBHOOK_LIBRARY_ITEMS.find((i) => i.service === service) ?? activeLibraryItem;
    return {
      id: "active-preview",
      timestampLabel: "Armed preview",
      isLiveDispatched: false,
      providerId: matched.providerId,
      providerLabel: matched.providerLabel,
      eventType: matched.eventType,
      pathname: `/v2/webhooks/${matched.providerId}/${service}`,
      service,
      p95Ms: parsedP95,
      payloadText,
      fault,
      mode,
      idempotencyKey,
      response: activePreviewResponse,
    };
  }, [activeLibraryItem, activePreviewResponse, fault, idempotencyKey, mode, parsedP95, payloadText, service]);

  const seededEntries = useMemo(() => buildSeededStreamEntries(liveAiConfigured), [liveAiConfigured]);

  const allStreamEntries = useMemo<ReadonlyArray<StreamDeliveryEntry>>(
    () => [...liveDispatchedEntries, activePreviewEntry, ...seededEntries.slice(1)],
    [activePreviewEntry, liveDispatchedEntries, seededEntries],
  );

  const filteredStreamEntries = useMemo(() => {
    const q = streamSearch.trim().toLowerCase();
    return allStreamEntries.filter((entry) => {
      if (providerFilter !== "all" && entry.providerId !== providerFilter) return false;
      if (serviceFilter !== "all" && entry.service !== serviceFilter) return false;
      if (statusFilter === "accepted" && entry.response.webhookStatus !== "accepted") return false;
      if (statusFilter === "duplicate" && entry.response.webhookStatus !== "duplicate") return false;
      if (statusFilter === "rejected" && entry.response.httpStatus !== 401) return false;
      if (statusFilter === "bait" && !entry.response.injectionDetected) return false;
      if (!q) return true;
      const runbook = entry.response.mcpOutput?.recommendedRunbook ?? "";
      return (
        entry.idempotencyKey.toLowerCase().includes(q) ||
        entry.service.toLowerCase().includes(q) ||
        entry.providerLabel.toLowerCase().includes(q) ||
        entry.eventType.toLowerCase().includes(q) ||
        entry.pathname.toLowerCase().includes(q) ||
        runbook.toLowerCase().includes(q)
      );
    });
  }, [allStreamEntries, providerFilter, serviceFilter, statusFilter, streamSearch]);

  const selectedEntry = useMemo<StreamDeliveryEntry>(() => {
    return (
      allStreamEntries.find((e) => e.id === selectedStreamId) ??
      filteredStreamEntries[0] ??
      activePreviewEntry
    );
  }, [activePreviewEntry, allStreamEntries, filteredStreamEntries, selectedStreamId]);

  const streamCounts = useMemo(() => {
    let accepted = 0;
    let duplicate = 0;
    let rejected = 0;
    let bait = 0;
    for (const item of allStreamEntries) {
      if (item.response.webhookStatus === "accepted") accepted += 1;
      if (item.response.webhookStatus === "duplicate") duplicate += 1;
      if (item.response.httpStatus === 401) rejected += 1;
      if (item.response.injectionDetected) bait += 1;
    }
    return { accepted, duplicate, rejected, bait };
  }, [allStreamEntries]);

  const executeWebhookDispatch = useCallback(
    async (override?: {
      readonly service: string;
      readonly p95Ms: number;
      readonly payloadText: string;
      readonly idempotencyKey: string;
      readonly fault: FaultMode;
      readonly providerId?: WebhookProviderId;
      readonly providerLabel?: string;
      readonly eventType?: string;
      readonly pathname?: string;
    }) => {
      const targetService = override?.service ?? service;
      const targetP95 = override?.p95Ms ?? parsedP95;
      const targetPayload = override?.payloadText ?? payloadText;
      const targetKey =
        override?.idempotencyKey?.trim() || idempotencyKey.trim() || generateFreshKey(targetService);
      const targetFault = override?.fault ?? fault;

      setBannerState({ kind: "dispatching", targetService });
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            fault: targetFault,
            idempotencyKey: targetKey,
            service: targetService,
            p95Ms: targetP95,
            payloadText: targetPayload,
          }),
        });
        const data = (await res.json()) as TriageApiResponse & { error?: string };
        if (res.status !== 200 && res.status !== 401) {
          setBannerState({ kind: "error", message: data.error ?? `Request failed (${res.status})` });
          return;
        }
        setClaimedKeyCount(data.claimedKeyCount);
        setLiveAiConfigured(data.liveAiConfigured);

        const matchedLib =
          WEBHOOK_LIBRARY_ITEMS.find((i) => i.service === targetService) ?? WEBHOOK_LIBRARY_ITEMS[0]!;
        const entryId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timestampLabel = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        const newEntry: StreamDeliveryEntry = {
          id: entryId,
          timestampLabel,
          isLiveDispatched: true,
          providerId: override?.providerId ?? matchedLib.providerId,
          providerLabel: override?.providerLabel ?? matchedLib.providerLabel,
          eventType: override?.eventType ?? matchedLib.eventType,
          pathname:
            override?.pathname ??
            `/v2/webhooks/${override?.providerId ?? matchedLib.providerId}/${targetService}`,
          service: targetService,
          p95Ms: targetP95,
          payloadText: targetPayload,
          fault: targetFault,
          mode,
          idempotencyKey: targetKey,
          response: data,
        };
        setLiveDispatchedEntries((prev) => [newEntry, ...prev.slice(0, 14)]);
        setSelectedStreamId(entryId);
        setBannerState({ kind: "idle" });
      } catch (err) {
        setBannerState({
          kind: "error",
          message: err instanceof Error ? err.message : "Network error invoking /api/triage",
        });
      }
    },
    [fault, idempotencyKey, mode, parsedP95, payloadText, service],
  );

  const selectLibraryItem = useCallback((item: WebhookLibraryItem) => {
    setSelectedLibraryId(item.id);
    setService(item.service);
    setP95Input(String(item.p95Ms));
    setPayloadText(item.payloadText);
    setFault(item.defaultFault);
    setIdempotencyKey(
      item.id === WEBHOOK_LIBRARY_ITEMS[0]!.id
        ? `evt-${item.service}-demo`
        : generateFreshKey(item.service),
    );
    setSelectedStreamId("active-preview");
    setBannerState({ kind: "idle" });
  }, []);

  const fireLibraryItem = useCallback(
    async (item: WebhookLibraryItem) => {
      const nextKey =
        fault === "duplicate_replay"
          ? idempotencyKey
          : item.id === WEBHOOK_LIBRARY_ITEMS[0]!.id && liveDispatchedEntries.length === 0
            ? `evt-${item.service}-demo`
            : generateFreshKey(item.service);
      setSelectedLibraryId(item.id);
      setService(item.service);
      setP95Input(String(item.p95Ms));
      setPayloadText(item.payloadText);
      setIdempotencyKey(nextKey);
      setLibraryDrawerOpen(false);
      await executeWebhookDispatch({
        service: item.service,
        p95Ms: item.p95Ms,
        payloadText: item.payloadText,
        idempotencyKey: nextKey,
        fault,
        providerId: item.providerId,
        providerLabel: item.providerLabel,
        eventType: item.eventType,
        pathname: item.pathname,
      });
    },
    [executeWebhookDispatch, fault, idempotencyKey, liveDispatchedEntries.length],
  );

  const resetLedger = useCallback(async () => {
    setBannerState({ kind: "resetting" });
    try {
      const res = await fetch("/api/triage/reset", { method: "POST" });
      if (res.ok) {
        setClaimedKeyCount(0);
        setLiveDispatchedEntries([]);
        setSelectedStreamId("active-preview");
        setIdempotencyKey(generateFreshKey(service));
        setBannerState({
          kind: "notice",
          message: "Cleared session cookie ledger. Keys ready for fresh claims.",
        });
      }
    } catch {
      setBannerState({ kind: "error", message: "Could not reset session ledger cookie." });
    }
  }, [service]);

  const slaInfo = useMemo(
    () => getServiceSlaInfo(selectedEntry.service, selectedEntry.p95Ms),
    [selectedEntry.p95Ms, selectedEntry.service],
  );
  const timingPhases = useMemo(
    () => computeTimingPhaseWaterfall(selectedEntry.response),
    [selectedEntry.response],
  );
  const curlSnippet = useMemo(
    () => formatSignedCurlCommand(selectedEntry.response, originUrl),
    [originUrl, selectedEntry.response],
  );
  const pythonSnippet = useMemo(
    () =>
      formatPythonSdkSnippet(
        selectedEntry.response,
        selectedEntry.service,
        selectedEntry.p95Ms,
        selectedEntry.payloadText,
      ),
    [selectedEntry.p95Ms, selectedEntry.payloadText, selectedEntry.service, selectedEntry.response],
  );

  return {
    providerFilter,
    setProviderFilter,
    selectedLibraryId,
    service,
    setService,
    p95Input,
    setP95Input,
    payloadText,
    setPayloadText,
    idempotencyKey,
    setIdempotencyKey,
    fault,
    setFault,
    mode,
    setMode,
    libraryDrawerOpen,
    setLibraryDrawerOpen,
    libraryTab,
    setLibraryTab,
    liveAiConfigured,
    claimedKeyCount,
    liveDispatchedCount: liveDispatchedEntries.length,
    allStreamEntries,
    filteredStreamEntries,
    selectedEntry,
    selectedStreamId,
    setSelectedStreamId,
    bannerState,
    setBannerState,
    showFacetSidebar,
    setShowFacetSidebar,
    statusFilter,
    setStatusFilter,
    serviceFilter,
    setServiceFilter,
    streamSearch,
    setStreamSearch,
    streamCounts,
    slaInfo,
    timingPhases,
    originUrl,
    curlSnippet,
    pythonSnippet,
    knownServices: KNOWN_SERVICES,
    executeWebhookDispatch,
    selectLibraryItem,
    fireLibraryItem,
    resetLedger,
  };
}
