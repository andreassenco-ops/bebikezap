"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X } from "lucide-react";
import { formatDistanceStrict, formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DATE_FNS_LOCALE } from "@/lib/locale";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

/** Light backgrounds (e.g. pastel tags) need dark text. */
function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};




export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const { user } = useAuth();
  const canTake = useCan("send-messages");

  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  // Pools (migrations 043/045): unassigned conversations still with the bot,
  // since when each waiting customer has waited, and agent names for "Em atendimento".
  const [botConversationIds, setBotConversationIds] = useState<Set<string>>(() => new Set());
  const [waitingSince, setWaitingSince] = useState<Map<string, string>>(() => new Map());
  const [agentNames, setAgentNames] = useState<Map<string, string>>(() => new Map());
  const [openSections, setOpenSections] = useState({ automated: false, waiting: false, mine: false, inService: false });
  const [now, setNow] = useState(() => Date.now());
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ponytail: polls every 20s and on any status/assignment change; fine at one lab's volume.
  // last_message_at included so a reopened chat is re-checked once the URA has started.
  const poolKey = conversations.map((c) => `${c.id}:${c.status}:${c.assigned_agent_id ?? ""}:${c.last_message_at ?? ""}`).join("|");
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const [runs, queue] = await Promise.all([
        supabase.from("flow_runs").select("conversation_id").eq("status", "active"),
        supabase.from("conversation_queue").select("id, waiting_since"),
      ]);
      if (cancelled) return;
      setBotConversationIds(new Set((runs.data ?? []).map((r) => r.conversation_id as string)));
      setWaitingSince(new Map((queue.data ?? []).map((q) => [q.id as string, q.waiting_since as string])));
      setNow(Date.now());
    };
    const first = setTimeout(load, 0);
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [poolKey, resyncToken]);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name")
      .then(({ data }) => {
        if (!cancelled) setAgentNames(new Map((data ?? []).map((p) => [p.user_id as string, (p.full_name as string) || ""])));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    // Closed conversations leave the inbox; everyone sees every pool.
    let result = conversations.filter((c) => c.status !== "closed");

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, search, selectedTagIds, selectedCompany]);

  // 1) bot/flow or AI still handling  2) waiting for a human  3) taken by an agent
  const pools = useMemo(() => {
    const automated: Conversation[] = [];
    const waiting: Conversation[] = [];
    const mine: Conversation[] = [];
    const inService: Conversation[] = [];
    for (const c of filtered) {
      if (c.assigned_agent_id === user?.id) mine.push(c);
      else if (c.assigned_agent_id) inService.push(c);
      else if (botConversationIds.has(c.id) || (((c.ai_reply_count ?? 0) > 0 || c.ai_agent_id) && !c.ai_autoreply_disabled)) automated.push(c);
      else waiting.push(c);
    }
    const since = (c: Conversation) => waitingSince.get(c.id) ?? c.last_message_at ?? "";
    waiting.sort((a, b) => since(a).localeCompare(since(b))); // quem espera há mais tempo primeiro
    return { automated, waiting, mine, inService };
  }, [filtered, botConversationIds, waitingSince, user?.id]);

  const elapsed = useCallback(
    (iso?: string | null) => (iso ? formatDistanceStrict(new Date(iso), now, { locale: DATE_FNS_LOCALE }) : "—"),
    [now],
  );

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  // Atomic: only succeeds while still unassigned, so two agents can't take the same chat.
  const takeConversation = useCallback(
    async (conv: Conversation) => {
      if (!user) return;
      const assignedAt = new Date().toISOString();
      const { data, error } = await createClient()
        .from("conversations")
        .update({ assigned_agent_id: user.id, assigned_at: assignedAt, status: "open" })
        .eq("id", conv.id)
        .is("assigned_agent_id", null)
        .select("id");
      if (error || !data?.length) {
        toast.error(t("alreadyTaken"));
        return;
      }
      toast.success(t("taken"));
      onSelect({ ...conv, assigned_agent_id: user.id, assigned_at: assignedAt, status: "open" });
    },
    [user, onSelect, t],
  );

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="flex flex-col">
            {(
              [
                ["automated", t("sectionAutomated"), pools.automated],
                ["waiting", t("sectionWaiting"), pools.waiting],
                ["mine", t("sectionMine"), pools.mine],
                ["inService", t("sectionInService"), pools.inService],
              ] as const
            ).map(([key, title, list]) => (
              <section key={key}>
                <button
                  type="button"
                  onClick={() => setOpenSections((o) => ({ ...o, [key]: !o[key] }))}
                  className="flex w-full items-center justify-between border-b border-border bg-muted/40 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted"
                >
                  <span>
                    {title} ({list.length})
                  </span>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", !openSections[key] && "-rotate-90")} />
                </button>
                {openSections[key] &&
                  (list.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-muted-foreground">{t("emptySection")}</p>
                  ) : (
                    list.map((conv) => (
                      <div key={conv.id} className="flex items-center">
                        <div className="min-w-0 flex-1">
                          <ConversationItem
                            conversation={conv}
                            isActive={conv.id === activeConversationId}
                            onSelect={handleSelect}
                            t={t}
                            meta={
                              key === "waiting"
                                ? t("waitingFor", { time: elapsed(waitingSince.get(conv.id) ?? conv.last_message_at) })
                                : key === "inService" || key === "mine"
                                  ? t("inServiceBy", {
                                      name: agentNames.get(conv.assigned_agent_id ?? "") || "—",
                                      time: elapsed(conv.assigned_at ?? conv.updated_at),
                                    })
                                  : null
                            }
                          />
                        </div>
                        {key === "waiting" && canTake && (
                          <Button size="sm" variant="outline" className="mr-3 shrink-0" onClick={() => takeConversation(conv)}>
                            {t("take")}
                          </Button>
                        )}
                      </div>
                    ))
                  ))}
              </section>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  /** Pool-specific line: waiting time, or agent + time in service. */
  meta?: string | null;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  meta,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: DATE_FNS_LOCALE,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
        {(meta || (contact?.tags?.length ?? 0) > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {contact?.tags?.map((tag) => {
              // Tags named "💉 Vacinas" show only the symbol; the full name is the tooltip.
              const symbol = tag.name.match(/^\p{Extended_Pictographic}️?/u)?.[0];
              return (
                <span
                  key={tag.id}
                  title={tag.name}
                  className={cn(
                    "rounded-full font-medium",
                    symbol ? "flex h-5 w-5 items-center justify-center text-xs" : "px-1.5 py-0.5 text-[10px]",
                    isLightColor(tag.color) ? "text-black" : "text-white",
                  )}
                  style={{ backgroundColor: tag.color }}
                >
                  {symbol ?? tag.name}
                </span>
              );
            })}
            {meta && <span className="text-[10px] text-muted-foreground">{meta}</span>}
          </div>
        )}
      </div>
    </button>
  );
}
