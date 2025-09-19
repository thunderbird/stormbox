import { ref, reactive, computed, onMounted } from "vue";
import { useInfiniteQuery, useQueryClient } from "@tanstack/vue-query";
import { JMAPClient } from "../services/jmap.js";

export function useEmailStore() {
  // Connection state
  const connected = ref(false);
  const status = ref("Not connected.");
  const error = ref("");
  const client = ref(null);

  // Data
  const mailboxes = ref([]);
  const identities = ref([]);
  const currentMailboxId = ref(null);
  const selectedEmailId = ref(null);

  // Compose state
  const composeOpen = ref(false);
  const sending = ref(false);
  const composeStatus = ref("");
  const composeDebug = ref("");
  const compose = reactive({
    fromIdx: 0,
    to: "",
    subject: "",
    html: "",
    text: "",
  });

  // View state
  const viewMode = ref("all");
  const filterText = ref("");

  // Config
  const PAGE_SIZE = 100;
  const INITIAL_LOAD_COUNT = 50;
  const INITIAL_PREFETCH_TARGET = 500;
  const DEBUG_LOAD = false;

  // Email content
  const bodyHtml = ref("");
  const bodyText = ref("");
  const cidUrls = reactive({});

  // Computed properties
  const currentBox = computed(
    () => mailboxes.value.find((m) => m.id === currentMailboxId.value) || null
  );

  const visibleMessages = computed(() => {
    let arr = emailsFromQuery.value || [];

    if (viewMode.value === "unread") arr = arr.filter((m) => !m.isSeen);

    if (filterText.value) {
      const ft = filterText.value.toLowerCase();
      arr = arr.filter(
        (m) =>
          (m.fromText || "").toLowerCase().includes(ft) ||
          (m.subject || "").toLowerCase().includes(ft)
      );
    }

    return arr;
  });

  // Utility functions
  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso || "";
    }
  };

  const sortPropForBox = (box) => {
    const b = box || currentBox.value;
    if (!b) return "receivedAt";
    const role = (b.role || "").toLowerCase();
    const name = (b.name || "").toLowerCase();
    return role === "sent" || name === "sent" || name === "sent items"
      ? "sentAt"
      : "receivedAt";
  };

  const joinAddrs = (list) => {
    return (list || [])
      .map((a) => {
        const n = (a.name || "").trim();
        const e = (a.email || "").trim();
        return e ? (n ? `${n} <${e}>` : e) : "";
      })
      .filter(Boolean)
      .join(", ");
  };

  // Connect to JMAP server
  const connect = async (credentials) => {
    if (!credentials || !credentials.username || !credentials.password) {
      error.value = "Username and password required.";
      return;
    }

    error.value = "";
    status.value = "Connecting…";

    try {
      client.value = new JMAPClient({
        baseUrl: import.meta.env.VITE_JMAP_SERVER_URL || "https://mail.tb.pro",
        username: credentials.username.trim(),
        password: credentials.password,
      });
      await client.value.fetchSession();

      mailboxes.value = await client.value.listMailboxes();
      identities.value = await client.value.listIdentities();

      currentMailboxId.value = client.value.ids.inbox || mailboxes.value[0]?.id;
      connected.value = true;
      document.body.classList.add("connected");

      // Save username only for auto-connect (password not stored for security)
      localStorage.setItem("jmap.username", credentials.username.trim());

      // Start automatic delta updates
      startDeltaUpdates();

      // Prime Vue Query pages for the initial mailbox
      if (DEBUG_LOAD)
        console.debug(
          "[vue-query] Priming initial mailbox",
          currentMailboxId.value
        );

      try {
        await mailboxInfinite.refetch();
        if (DEBUG_LOAD) console.debug("[vue-query] Refetch completed");
      } catch (e) {
        if (DEBUG_LOAD) console.debug("[vue-query] Refetch error", e);
      }

      // Load initial pages
      for (let i = 0; i < 3; i++) {
        try {
          await mailboxInfinite.fetchNextPage();
          if (DEBUG_LOAD)
            console.debug("[vue-query] fetchNextPage completed", i + 1);
        } catch (e) {
          if (DEBUG_LOAD) console.debug("[vue-query] fetchNextPage error", e);
          break;
        }
      }
    } catch (e) {
      status.value = "Failed.";
      error.value =
        e.message +
        (e.message?.includes("Failed to fetch")
          ? "\nLikely CORS/network issue."
          : "");
    }
  };

  const normalizeEmails = (emails) =>
    emails.map((m) => ({
      ...m,
      fromText: joinAddrs(m.from),
      isSeen: !!m.keywords?.["$seen"],
      hasAttachment: !!m.hasAttachment,
      size: m.size,
      preview: (m.preview || "").trim(),
    }));

  // Vue Query: infinite list per mailbox
  const queryClient = useQueryClient();
  const emailListKey = (boxId, sortProp) => ["emails", boxId, sortProp];

  const mailboxInfinite = useInfiniteQuery({
    queryKey: computed(() =>
      emailListKey(currentMailboxId.value, sortPropForBox(currentBox.value))
    ),
    queryFn: async ({ pageParam = 0 }) => {
      const boxId = currentMailboxId.value;
      if (!boxId || !client.value) {
        return { qr: { ids: [], total: 0 }, list: [] };
      }
      const sortProp = sortPropForBox(currentBox.value);
      const qr = await client.value.emailQuery({
        mailboxId: boxId,
        position: pageParam,
        limit: PAGE_SIZE,
        sortProp,
      });
      const ids = qr.ids || [];
      let emails = [];
      if (ids.length) {
        const props = [
          "id",
          "threadId",
          "mailboxIds",
          "subject",
          "from",
          "to",
          "cc",
          "bcc",
          "replyTo",
          "sender",
          "receivedAt",
          "sentAt",
          "preview",
          "keywords",
          "hasAttachment",
          "size",
        ];
        emails = await client.value.emailGet(ids, props);
      }
      const list = normalizeEmails(emails);
      return { qr, list };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const qr = last?.qr || {};
      const ids = qr.ids || [];
      const pos =
        typeof qr.position === "number" ? qr.position + ids.length : ids.length;
      const more =
        typeof qr.total === "number"
          ? pos < qr.total
          : ids.length === PAGE_SIZE;
      return more ? pos : undefined;
    },
    staleTime: 30_000, // Consider data stale after 30 seconds
    gcTime: 5 * 60_000, // Keep in cache for 5 minutes
    refetchInterval: false, // We'll use custom delta updates instead
    refetchOnWindowFocus: false, // We'll handle this with delta updates
    refetchOnMount: true, // Refetch when component mounts
    refetchOnReconnect: true, // Refetch when network reconnects
    enabled: computed(() => connected.value && !!currentMailboxId.value),
  });

  const emailsFromQuery = computed(
    () => mailboxInfinite.data?.value?.pages?.flatMap((p) => p.list || []) || []
  );

  const totalEmailsCount = computed(() => {
    const firstPage = mailboxInfinite.data?.value?.pages?.[0];
    return (
      firstPage?.qr?.total ??
      mailboxes.value.find((m) => m.id === currentMailboxId.value)
        ?.totalEmails ??
      emailsFromQuery.value.length
    );
  });

  // Switch mailbox
  const switchMailbox = async (id) => {
    if (DEBUG_LOAD) console.debug("[vue-query] Switching mailbox to", id);

    currentMailboxId.value = id;
    selectedEmailId.value = null;

    // Cancel ongoing requests
    try {
      client.value?.cancelAll?.();
    } catch {}

    await new Promise((r) => setTimeout(r, 50)); // Let Vue Query react

    // Vue Query: Check if we have cached data for this folder
    const queryKey = emailListKey(id, sortPropForBox(currentBox.value));
    const cachedData = queryClient.getQueryData(queryKey);

    if (cachedData) {
      // We have cached data - invalidate to mark as stale and trigger background refetch
      if (DEBUG_LOAD)
        console.debug(
          "[vue-query] Have cached data for",
          queryKey,
          "- invalidating to check for updates"
        );
      await queryClient.invalidateQueries({ queryKey, refetchType: "active" });
    } else if (DEBUG_LOAD) {
      console.debug(
        "[vue-query] No cached data for",
        queryKey,
        "- fetching fresh"
      );
    }

    // Prime first page and load a few more
    try {
      await mailboxInfinite.refetch();
      if (DEBUG_LOAD)
        console.debug("[vue-query] Refetch completed for mailbox", id);
    } catch (e) {
      if (DEBUG_LOAD) console.debug("[vue-query] Refetch error", e);
    }

    // Load initial pages
    for (let i = 0; i < 3; i++) {
      try {
        await mailboxInfinite.fetchNextPage();
        if (DEBUG_LOAD)
          console.debug("[vue-query] fetchNextPage completed", i + 1);
      } catch (e) {
        if (DEBUG_LOAD) console.debug("[vue-query] fetchNextPage error", e);
        break;
      }
    }
  };

  // Handle virtual scroll range changes
  const onVirtRange = async (endIndex) => {
    const pages = mailboxInfinite.data?.value?.pages || [];
    const loaded = pages.reduce((sum, p) => sum + (p.list?.length || 0), 0);

    // Prefetch ahead when approaching the end of loaded data
    if (
      endIndex > loaded - Math.floor(PAGE_SIZE / 2) &&
      mailboxInfinite.hasNextPage?.value
    ) {
      try {
        await mailboxInfinite.fetchNextPage();
      } catch (e) {
        console.debug("[vue-query] Error fetching next page:", e);
      }
    }
  };

  // Message detail
  const detail = reactive({
    subject: "(select a message)",
    from: "",
    to: "",
    cc: "",
    date: "",
    flags: "",
    size: "",
    id: "",
    preview: "",
  });
  const attachments = reactive([]);

  const selectMessage = async (id) => {
    selectedEmailId.value = id;
    // Look for message in Vue Query data first
    const emails = emailsFromQuery.value || [];
    let m = emails.find((x) => x.id === id);

    if (!m) return clearDetail();

    detail.subject = m.subject || "(no subject)";
    detail.from = m.fromText || "";
    detail.to = joinAddrs(m.to) || "";
    detail.cc = joinAddrs(m.cc) || "";
    const dp =
      sortPropForBox(currentBox.value) === "sentAt" ? "sentAt" : "receivedAt";
    detail.date = fmtDate(m[dp]);
    const flags =
      Object.keys(m.keywords || {})
        .filter((k) => m.keywords[k])
        .join(", ") || (m.isSeen ? "$seen" : "");
    detail.flags = flags;
    detail.size = m.size != null ? `${m.size} bytes` : "";
    detail.id = m.id || "";
    detail.preview = (m.preview || "").trim();

    // reset previous body/cid URLs
    Object.keys(cidUrls).forEach((k) => {
      URL.revokeObjectURL(cidUrls[k]);
      delete cidUrls[k];
    });
    bodyHtml.value = "";
    bodyText.value = "";

    try {
      const info = await client.value.emailDetail(m.id);
      attachments.splice(0, attachments.length, ...info.attachments);
      bodyText.value = info.text || "";
      bodyHtml.value = info.html
        ? await resolveCidImages(info.html, info.cidMap || {})
        : "";
      if (!bodyHtml.value && !bodyText.value) bodyText.value = m.preview || "";
    } catch (e) {
      console.debug("Failed to load email detail:", e);
      attachments.splice(0);
      bodyHtml.value = "";
      bodyText.value = m.preview || "";
    }

    if (!m.isSeen) {
      // Update the mailbox unread count
      const mb = mailboxes.value.find((x) => x.id === currentMailboxId.value);
      if (mb && typeof mb.unreadEmails === "number" && mb.unreadEmails > 0)
        mb.unreadEmails--;

      // Optimistically update the Vue Query cache
      const queryKey = [
        "emails",
        currentMailboxId.value,
        sortPropForBox(currentBox.value),
      ];
      queryClient.setQueryData(queryKey, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            list: page.list?.map((email) =>
              email.id === m.id
                ? {
                    ...email,
                    isSeen: true,
                    keywords: { ...email.keywords, $seen: true },
                  }
                : email
            ),
          })),
        };
      });

      // Mark as read on the server
      try {
        await client.value.setSeen(m.id, true);
      } catch (e) {
        // On error, revert the optimistic update
        await queryClient.invalidateQueries({ queryKey });
      }
    }
  };

  const clearDetail = () => {
    detail.subject = "(select a message)";
    detail.from =
      detail.to =
      detail.cc =
      detail.date =
      detail.flags =
      detail.size =
      detail.id =
      detail.preview =
        "";
    attachments.splice(0);
    Object.keys(cidUrls).forEach((k) => {
      URL.revokeObjectURL(cidUrls[k]);
      delete cidUrls[k];
    });
    bodyHtml.value = bodyText.value = "";
  };

  // Manual refresh function to check for updates
  const refreshCurrentMailbox = async () => {
    if (!currentMailboxId.value) return;

    const queryKey = emailListKey(
      currentMailboxId.value,
      sortPropForBox(currentBox.value)
    );

    // Try to do an efficient delta update first
    const success = await checkForDeltaUpdates();

    if (!success) {
      // Fall back to full refresh if delta update failed
      await queryClient.invalidateQueries({
        queryKey,
        refetchType: "active",
      });

      // Also refetch the infinite query
      await mailboxInfinite.refetch();
    }
  };

  // Efficient delta update using JMAP queryChanges
  const checkForDeltaUpdates = async () => {
    if (!currentMailboxId.value || !client.value) return false;

    const queryKey = emailListKey(
      currentMailboxId.value,
      sortPropForBox(currentBox.value)
    );

    const currentData = queryClient.getQueryData(queryKey);
    if (!currentData?.pages?.length) return false;

    // Get the queryState from the first page
    const queryState = currentData.pages[0]?.qr?.queryState;
    if (!queryState) return false;

    try {
      // Fetch only changes since our last sync
      const changes = await client.value.emailQueryChanges({
        mailboxId: currentMailboxId.value,
        sinceQueryState: queryState,
        sortProp: sortPropForBox(currentBox.value),
      });

      if (changes.error || !changes.newQueryState) {
        // State is too old, need full refresh
        return false;
      }

      // Apply the changes to our cached data
      await applyDeltaChanges(queryKey, changes);
      return true;
    } catch (e) {
      console.debug("[delta] Failed to get changes:", e);
      return false;
    }
  };

  // Apply delta changes to the cached query data
  const applyDeltaChanges = async (queryKey, changes) => {
    const { added = [], removed = [], newQueryState, total } = changes;

    if (DEBUG_LOAD) {
      console.debug("[delta] Applying changes:", {
        added: added.length,
        removed: removed.length,
        newState: newQueryState,
        total,
      });
    }

    // Fetch details for added emails if any
    let newEmails = [];
    if (added.length > 0) {
      const addedIds = added.map((a) => a.id);
      const props = [
        "id",
        "threadId",
        "mailboxIds",
        "subject",
        "from",
        "to",
        "cc",
        "bcc",
        "replyTo",
        "sender",
        "receivedAt",
        "sentAt",
        "preview",
        "keywords",
        "hasAttachment",
        "size",
      ];
      const emails = await client.value.emailGet(addedIds, props);
      newEmails = normalizeEmails(emails);
    }

    // Update the cached data with the changes
    queryClient.setQueryData(queryKey, (oldData) => {
      if (!oldData) return oldData;

      return {
        ...oldData,
        pages: oldData.pages.map((page, pageIndex) => {
          if (pageIndex === 0) {
            // Update the first page with new queryState and total
            let updatedList = page.list || [];

            // Remove deleted emails
            if (removed.length > 0) {
              const removedSet = new Set(removed);
              updatedList = updatedList.filter(
                (email) => !removedSet.has(email.id)
              );
            }

            // Add new emails at their correct positions
            for (const addedItem of added) {
              const { id, index } = addedItem;
              const newEmail = newEmails.find((e) => e.id === id);
              if (newEmail && index != null) {
                // Insert at the specified index
                updatedList.splice(index, 0, newEmail);
              }
            }

            return {
              ...page,
              list: updatedList,
              qr: {
                ...page.qr,
                queryState: newQueryState,
                total: total != null ? total : page.qr?.total,
              },
            };
          }
          return page;
        }),
      };
    });
  };

  const backToList = () => {
    selectedEmailId.value = null;
    clearDetail();
  };

  const deleteCurrent = async () => {
    if (!selectedEmailId.value) return;

    // Look for message in Vue Query data first
    const emails = emailsFromQuery.value || [];
    let m = emails.find((x) => x.id === selectedEmailId.value);

    if (!m) return;
    try {
      const wasUnread = !m.isSeen;

      // Optimistically update the Vue Query cache
      const queryKey = [
        "emails",
        currentMailboxId.value,
        sortPropForBox(currentBox.value),
      ];
      queryClient.setQueryData(queryKey, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            list: page.list?.filter((email) => email.id !== m.id),
            qr: page.qr
              ? {
                  ...page.qr,
                  total: Math.max(0, (page.qr.total || 0) - 1),
                }
              : page.qr,
          })),
        };
      });

      // Update mailbox unread count if needed
      if (wasUnread) {
        const mb = mailboxes.value.find((x) => x.id === currentMailboxId.value);
        if (mb && mb.unreadEmails > 0) mb.unreadEmails--;
      }

      selectedEmailId.value = null;
      clearDetail();

      // Delete on the server
      await client.value.moveToTrashOrDestroy(m.id, currentMailboxId.value);
    } catch (e) {
      error.value = "Delete failed: " + e.message;
      // On error, revert the optimistic update
      await queryClient.invalidateQueries({
        queryKey: [
          "emails",
          currentMailboxId.value,
          sortPropForBox(currentBox.value),
        ],
      });
    }
  };

  // CID image resolution
  const resolveCidImages = async (html, cidMap) => {
    const re = /src=["']cid:([^"']+)["']/gi;
    let result = html;
    let match;
    while ((match = re.exec(html))) {
      const cid = match[1];
      const blobId = cidMap?.[cid];
      if (!blobId) continue;
      if (!cidUrls[cid]) {
        try {
          const url = client.value.makeDownloadUrl(blobId, cid + ".bin");
          const r = await fetch(url, {
            headers: { Authorization: client.value.AUTH },
            mode: "cors",
            credentials: "omit",
          });
          if (r.ok) {
            const blob = await r.blob();
            cidUrls[cid] = URL.createObjectURL(blob);
          }
        } catch {}
      }
      if (cidUrls[cid]) {
        result = result.replaceAll(`cid:${cid}`, cidUrls[cid]);
      }
    }
    return result;
  };

  const ensureReSubject = (s) => {
    const t = (s || "(no subject)").trim();
    return /^re:/i.test(t) ? t : `Re: ${t}`;
  };

  const replyToCurrent = async () => {
    if (!selectedEmailId.value) return;

    // Look for message in Vue Query data first
    const emails = emailsFromQuery.value || [];
    let m = emails.find((x) => x.id === selectedEmailId.value);

    if (!m) return;

    let quotedHtml = "";
    let quotedText = "";

    // Always try to get the full email body for proper quoting
    try {
      // If body is already loaded from viewing the email, use it
      if (bodyHtml.value || bodyText.value) {
        quotedHtml = bodyHtml.value || bodyText.value || m.preview || "";
        quotedText = bodyText.value || m.preview || "";
      } else {
        // Fetch the full email body for quoting
        const info = await client.value.emailDetail(m.id);
        quotedHtml = info.html || info.text || m.preview || "";
        quotedText = info.text || m.preview || "";
      }
    } catch (e) {
      // If fetching fails, fall back to preview
      console.debug("Failed to fetch email body for reply, using preview:", e);
      quotedHtml = m.preview || "";
      quotedText = m.preview || "";
    }

    const who = m.fromText || "the sender";
    const when = fmtDate(m.receivedAt || m.sentAt);

    // Create reply with properly formatted quoted content
    const replyHtml = `<br><br><div style="color: #666;">On ${when}, ${who} wrote:</div><blockquote style="margin: 10px 0 0 10px; padding: 0 0 0 10px; border-left: 2px solid #ccc; color: #666;">${quotedHtml}</blockquote>`;
    const replyText = `\n\nOn ${when}, ${who} wrote:\n> ${quotedText.replace(
      /\n/g,
      "\n> "
    )}`;

    toggleCompose(true);
    compose.to = joinAddrs(
      m.replyTo && m.replyTo.length ? m.replyTo : m.from || []
    );
    compose.subject = ensureReSubject(m.subject);
    compose.html = replyHtml;
    compose.text = replyText;
    composeStatus.value = "";
    composeDebug.value = "";
  };

  const toggleCompose = (forceOpen) => {
    composeOpen.value = forceOpen === true ? true : !composeOpen.value;
    composeStatus.value = "";
    composeDebug.value = "";
    // Clear compose content when opening fresh (not called from reply)
    if (composeOpen.value && forceOpen !== true) {
      compose.to = "";
      compose.subject = "";
      compose.html = "";
      compose.text = "";
    }
  };

  const discard = () => {
    composeOpen.value = false;
    composeStatus.value = "";
    composeDebug.value = "";
    compose.to = "";
    compose.subject = "";
    compose.html = "";
    compose.text = "";
  };

  const parseAddrList = (input) =>
    (input || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/^(.+?)\s*<(.+?)>$/);
        return m
          ? { name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() }
          : { email: p };
      });

  const sanitizeForDebug = (obj) => {
    const copy = JSON.parse(JSON.stringify(obj));
    try {
      const calls = copy.methodCalls || [];
      for (const c of calls) {
        if (c[0] === "Email/set" && c[1]?.create) {
          for (const k of Object.keys(c[1].create)) {
            if (c[1].create[k]?.bodyValues) {
              for (const pid of Object.keys(c[1].create[k].bodyValues)) {
                const v = c[1].create[k].bodyValues[pid].value || "";
                c[1].create[k].bodyValues[pid].value =
                  v.length > 500 ? v.slice(0, 500) + "…[truncated]" : v;
              }
            }
          }
        }
      }
    } catch {}
    return copy;
  };

  const extractMethodErrors = (json) => {
    if (!json) return "";
    const issues = [];
    try {
      for (const [name, payload] of json.methodResponses || []) {
        ["notCreated", "notUpdated", "notDestroyed", "notSubmitted"].forEach(
          (k) => {
            if (payload?.[k]) {
              Object.entries(payload[k]).forEach(([id, err]) => {
                issues.push(
                  `${name}/${k}/${id}: ${err.type || "error"} - ${
                    err.description || "unknown"
                  }`
                );
              });
            }
          }
        );
      }
    } catch {}
    return issues.join("\n");
  };

  const send = async () => {
    if (!identities.value.length) {
      composeStatus.value = "No identities.";
      return;
    }
    const id = identities.value[compose.fromIdx] || identities.value[0];
    const from = {
      email: (id.email || "").trim(),
      name: (id.name || "").trim() || undefined,
    };
    const toList = parseAddrList(compose.to);
    if (!from.email || !id.id) {
      composeStatus.value = "From/Identity missing.";
      return;
    }
    if (!toList.length) {
      composeStatus.value = "Add at least one recipient.";
      return;
    }

    try {
      sending.value = true;
      composeStatus.value = "Sending…";
      composeDebug.value = "";

      const res = await client.value.sendMultipartAlternative({
        from,
        identityId: id.id,
        toList,
        subject: compose.subject || "",
        text: compose.text || "",
        html: compose.html || "",
        draftsId: client.value.ids.drafts,
        sentId: client.value.ids.sent,
      });

      const methodIssues = extractMethodErrors(res.json);
      composeDebug.value = `Started: ${res.started}\nStatus: ${res.status} ${
        res.statusText
      }\n\nRequest:\n${JSON.stringify(
        sanitizeForDebug(JSON.parse(res.req)),
        null,
        2
      )}\n\nResponse:\n${res.text}${
        methodIssues ? "\nMethod issues:\n" + methodIssues : ""
      }`;

      if (!res.ok) {
        composeStatus.value = `Send failed: ${res.status} ${res.statusText}`;
        return;
      }
      if (methodIssues) {
        const firstLine =
          String(methodIssues).split("\n").find(Boolean) ||
          "Unknown method error";
        composeStatus.value = "Send may have failed: " + firstLine;
        return;
      }
      composeStatus.value = "Sent.";
      discard();
      if (currentMailboxId.value === client.value.ids.sent)
        await refreshCurrentMailbox();
    } catch (e) {
      composeStatus.value = "Send failed: " + e.message;
    } finally {
      sending.value = false;
    }
  };

  const download = (a) => {
    client.value
      .downloadAttachment(a.blobId, a.name, a.type)
      .catch((e) => (error.value = "Download failed: " + e.message));
  };

  const setView = (mode) => {
    if (["all", "unread"].includes(mode)) viewMode.value = mode;
  };

  // Set up automatic delta updates
  let deltaUpdateInterval = null;

  const startDeltaUpdates = () => {
    // Clear any existing interval
    if (deltaUpdateInterval) {
      clearInterval(deltaUpdateInterval);
    }

    // Check for updates every 30 seconds
    deltaUpdateInterval = setInterval(() => {
      if (connected.value && currentMailboxId.value) {
        checkForDeltaUpdates();
      }
    }, 30_000);
  };

  const stopDeltaUpdates = () => {
    if (deltaUpdateInterval) {
      clearInterval(deltaUpdateInterval);
      deltaUpdateInterval = null;
    }
  };

  // Handle window focus for delta updates
  const handleWindowFocus = () => {
    if (connected.value && currentMailboxId.value) {
      checkForDeltaUpdates();
    }
  };

  // Keyboard shortcuts and lifecycle
  onMounted(() => {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && composeOpen.value)
        send();
      if (e.key === "Escape") {
        if (composeOpen.value) discard();
        else if (selectedEmailId.value) {
          selectedEmailId.value = null;
          clearDetail();
        }
      }
    });

    // Listen for window focus
    window.addEventListener("focus", handleWindowFocus);
  });

  return {
    // State
    connected,
    status,
    error,
    mailboxes,
    identities,
    currentMailboxId,
    selectedEmailId,
    composeOpen,
    compose,
    sending,
    composeStatus,
    composeDebug,
    viewMode,
    filterText,
    visibleMessages,
    totalEmailsCount,
    detail,
    attachments,
    bodyHtml,
    bodyText,

    // Actions
    connect,
    switchMailbox,
    refreshCurrentMailbox,
    setView,
    selectMessage,
    backToList,
    replyToCurrent,
    deleteCurrent,
    toggleCompose,
    discard,
    send,
    download,
    onVirtRange,
  };
}
