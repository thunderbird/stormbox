import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { useAuthStore } from './auth-store.js'

export const useEmailStore = defineStore('email', () => {
  const authStore = useAuthStore()

  const mailboxes = ref([])
  const currentMailboxId = ref(null)
  const selectedEmailId = ref(null)
  const initialized = ref(false)

  const viewMode = ref('all')
  const filterText = ref('')

  const PAGE_SIZE = 100
  const DEBUG_LOAD = false

  const bodyHtml = ref('')
  const bodyText = ref('')
  const cidUrls = reactive({})

  const detail = reactive({
    subject: '(select a message)',
    from: '',
    to: '',
    cc: '',
    date: '',
    flags: '',
    size: '',
    id: '',
    preview: '',
  })
  const attachments = reactive([])

  const currentBox = computed(
    () => mailboxes.value.find((m) => m.id === currentMailboxId.value) || null
  )

  // ── Utilities ──

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso || ''
    }
  }

  function joinAddrs(list) {
    return (list || [])
      .map((a) => {
        const n = (a.name || '').trim()
        const e = (a.email || '').trim()
        return e ? (n ? `${n} <${e}>` : e) : ''
      })
      .filter(Boolean)
      .join(', ')
  }

  function sortPropForBox(box) {
    const b = box || currentBox.value
    if (!b) return 'receivedAt'
    const role = (b.role || '').toLowerCase()
    const name = (b.name || '').toLowerCase()
    return role === 'sent' || name === 'sent' || name === 'sent items'
      ? 'sentAt'
      : 'receivedAt'
  }

  // ── Folder-name mapping for routing ──

  function displayName(m) {
    const role = (m.role || '').toLowerCase()
    const mailboxName = (m.name || '').toLowerCase()
    if (role === 'trash' || mailboxName === 'deleted items' || mailboxName === 'trash') return 'Trash'
    if (role === 'junk' || mailboxName === 'spam' || mailboxName === 'junk') return 'Spam'
    if (role === 'sent' || mailboxName === 'sent' || mailboxName === 'sent items') return 'Sent'
    if (role === 'drafts' || mailboxName === 'drafts') return 'Drafts'
    if (role === 'archive' || mailboxName === 'archive' || mailboxName === 'archives') return 'Archives'
    if (role === 'inbox' || mailboxName === 'inbox') return 'Inbox'
    return m.name || 'Mailbox'
  }

  function getMailboxUrlName(m) {
    return displayName(m).toLowerCase().replace(/\s+/g, '-')
  }

  function resolveMailboxByName(folderName) {
    if (!folderName) return null
    const target = folderName.toLowerCase()
    return mailboxes.value.find((m) => getMailboxUrlName(m) === target) || null
  }

  // ── Normalize raw JMAP emails ──

  function normalizeEmails(emails) {
    return emails.map((m) => ({
      ...m,
      fromText: joinAddrs(m.from),
      isSeen: !!m.keywords?.['$seen'],
      hasAttachment: !!m.hasAttachment,
      size: m.size,
      preview: (m.preview || '').trim(),
    }))
  }

  // ── Vue Query: infinite email list per mailbox ──

  const queryClient = useQueryClient()
  const emailListKey = (boxId, sortProp) => ['emails', boxId, sortProp]

  const mailboxInfinite = useInfiniteQuery({
    queryKey: computed(() =>
      emailListKey(currentMailboxId.value, sortPropForBox(currentBox.value))
    ),
    queryFn: async ({ pageParam = 0 }) => {
      const boxId = currentMailboxId.value
      if (!boxId || !authStore.client)
        return { qr: { ids: [], total: 0 }, list: [] }

      const sortProp = sortPropForBox(currentBox.value)
      const qr = await authStore.client.emailQuery({
        mailboxId: boxId,
        position: pageParam,
        limit: PAGE_SIZE,
        sortProp,
      })
      const ids = qr.ids || []
      let emails = []
      if (ids.length) {
        const props = [
          'id', 'threadId', 'mailboxIds', 'subject', 'from', 'to', 'cc',
          'bcc', 'replyTo', 'sender', 'receivedAt', 'sentAt', 'preview',
          'keywords', 'hasAttachment', 'size',
        ]
        emails = await authStore.client.emailGet(ids, props)
      }
      return { qr, list: normalizeEmails(emails) }
    },
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const qr = last?.qr || {}
      const ids = qr.ids || []
      const pos =
        typeof qr.position === 'number' ? qr.position + ids.length : ids.length
      const more =
        typeof qr.total === 'number'
          ? pos < qr.total
          : ids.length === PAGE_SIZE
      return more ? pos : undefined
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchOnReconnect: true,
    enabled: computed(() => authStore.connected && !!currentMailboxId.value),
  })

  const emailsFromQuery = computed(
    () => mailboxInfinite.data?.value?.pages?.flatMap((p) => p.list || []) || []
  )

  const totalEmailsCount = computed(() => {
    const firstPage = mailboxInfinite.data?.value?.pages?.[0]
    return (
      firstPage?.qr?.total ??
      mailboxes.value.find((m) => m.id === currentMailboxId.value)
        ?.totalEmails ??
      emailsFromQuery.value.length
    )
  })

  const visibleMessages = computed(() => {
    let arr = emailsFromQuery.value || []
    if (viewMode.value === 'unread') arr = arr.filter((m) => !m.isSeen)
    if (filterText.value) {
      const ft = filterText.value.toLowerCase()
      arr = arr.filter(
        (m) =>
          (m.fromText || '').toLowerCase().includes(ft) ||
          (m.subject || '').toLowerCase().includes(ft)
      )
    }
    return arr
  })

  // ── Initialization (called after auth) ──

  async function initialize() {
    if (initialized.value) return
    if (!authStore.client) return

    mailboxes.value = await authStore.client.listMailboxes()

    const { useComposeStore } = await import('./compose-store.js')
    const composeStore = useComposeStore()
    await composeStore.loadIdentities()

    startDeltaUpdates()
    initialized.value = true
  }

  // ── Mailbox switching ──

  async function switchMailboxByName(folderName) {
    const mailbox = resolveMailboxByName(folderName)
    if (!mailbox) return false
    await switchMailbox(mailbox.id)
    return true
  }

  async function switchMailbox(id) {
    if (id === currentMailboxId.value && emailsFromQuery.value.length > 0)
      return

    if (DEBUG_LOAD) console.debug('[vue-query] Switching mailbox to', id)
    currentMailboxId.value = id
    selectedEmailId.value = null

    try {
      authStore.client?.cancelAll?.()
    } catch {}

    await new Promise((r) => setTimeout(r, 50))

    const queryKey = emailListKey(id, sortPropForBox(currentBox.value))
    const cachedData = queryClient.getQueryData(queryKey)
    if (cachedData) {
      await queryClient.invalidateQueries({ queryKey, refetchType: 'active' })
    }

    try {
      await mailboxInfinite.refetch()
    } catch (e) {
      if (DEBUG_LOAD) console.debug('[vue-query] Refetch error', e)
    }

    for (let i = 0; i < 3; i++) {
      try {
        await mailboxInfinite.fetchNextPage()
      } catch (e) {
        if (DEBUG_LOAD) console.debug('[vue-query] fetchNextPage error', e)
        break
      }
    }
  }

  // ── Virtual-scroll prefetch ──

  async function onVirtRange(endIndex) {
    const pages = mailboxInfinite.data?.value?.pages || []
    const loaded = pages.reduce((sum, p) => sum + (p.list?.length || 0), 0)
    if (
      endIndex > loaded - Math.floor(PAGE_SIZE / 2) &&
      mailboxInfinite.hasNextPage?.value
    ) {
      try {
        await mailboxInfinite.fetchNextPage()
      } catch (e) {
        console.debug('[vue-query] Error fetching next page:', e)
      }
    }
  }

  // ── Message detail ──

  async function selectMessage(id) {
    selectedEmailId.value = id
    const emails = emailsFromQuery.value || []
    const m = emails.find((x) => x.id === id)
    if (!m) return clearDetail()

    detail.subject = m.subject || '(no subject)'
    detail.from = m.fromText || ''
    detail.to = joinAddrs(m.to) || ''
    detail.cc = joinAddrs(m.cc) || ''
    const dp =
      sortPropForBox(currentBox.value) === 'sentAt' ? 'sentAt' : 'receivedAt'
    detail.date = fmtDate(m[dp])
    detail.flags =
      Object.keys(m.keywords || {})
        .filter((k) => m.keywords[k])
        .join(', ') || (m.isSeen ? '$seen' : '')
    detail.size = m.size != null ? `${m.size} bytes` : ''
    detail.id = m.id || ''
    detail.preview = (m.preview || '').trim()

    Object.keys(cidUrls).forEach((k) => {
      URL.revokeObjectURL(cidUrls[k])
      delete cidUrls[k]
    })
    bodyHtml.value = ''
    bodyText.value = ''

    try {
      const info = await authStore.client.emailDetail(m.id)
      attachments.splice(0, attachments.length, ...info.attachments)
      bodyText.value = info.text || ''
      bodyHtml.value = info.html
        ? await resolveCidImages(info.html, info.cidMap || {})
        : ''
      if (!bodyHtml.value && !bodyText.value)
        bodyText.value = m.preview || ''
    } catch (e) {
      console.debug('Failed to load email detail:', e)
      attachments.splice(0)
      bodyHtml.value = ''
      bodyText.value = m.preview || ''
    }

    if (!m.isSeen) {
      const mb = mailboxes.value.find((x) => x.id === currentMailboxId.value)
      if (mb && typeof mb.unreadEmails === 'number' && mb.unreadEmails > 0)
        mb.unreadEmails--

      const qk = [
        'emails',
        currentMailboxId.value,
        sortPropForBox(currentBox.value),
      ]
      queryClient.setQueryData(qk, (oldData) => {
        if (!oldData) return oldData
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
        }
      })

      try {
        await authStore.client.setSeen(m.id, true)
      } catch {
        await queryClient.invalidateQueries({ queryKey: qk })
      }
    }
  }

  function clearDetail() {
    detail.subject = '(select a message)'
    detail.from =
      detail.to =
      detail.cc =
      detail.date =
      detail.flags =
      detail.size =
      detail.id =
      detail.preview =
        ''
    attachments.splice(0)
    Object.keys(cidUrls).forEach((k) => {
      URL.revokeObjectURL(cidUrls[k])
      delete cidUrls[k]
    })
    bodyHtml.value = bodyText.value = ''
  }

  function backToList() {
    selectedEmailId.value = null
    clearDetail()
  }

  // ── Refresh & delta sync ──

  async function refreshCurrentMailbox() {
    if (!currentMailboxId.value) return
    const queryKey = emailListKey(
      currentMailboxId.value,
      sortPropForBox(currentBox.value)
    )
    const success = await checkForDeltaUpdates()
    if (!success) {
      await queryClient.invalidateQueries({ queryKey, refetchType: 'active' })
      await mailboxInfinite.refetch()
    }
  }

  async function checkForDeltaUpdates() {
    if (!currentMailboxId.value || !authStore.client) return false
    const queryKey = emailListKey(
      currentMailboxId.value,
      sortPropForBox(currentBox.value)
    )
    const currentData = queryClient.getQueryData(queryKey)
    if (!currentData?.pages?.length) return false
    const queryState = currentData.pages[0]?.qr?.queryState
    if (!queryState) return false

    try {
      const changes = await authStore.client.emailQueryChanges({
        mailboxId: currentMailboxId.value,
        sinceQueryState: queryState,
        sortProp: sortPropForBox(currentBox.value),
      })
      if (changes.error || !changes.newQueryState) return false
      await applyDeltaChanges(queryKey, changes)
      return true
    } catch (e) {
      console.debug('[delta] Failed to get changes:', e)
      return false
    }
  }

  async function applyDeltaChanges(queryKey, changes) {
    const { added = [], removed = [], newQueryState, total } = changes

    let newEmails = []
    if (added.length > 0) {
      const addedIds = added.map((a) => a.id)
      const props = [
        'id', 'threadId', 'mailboxIds', 'subject', 'from', 'to', 'cc',
        'bcc', 'replyTo', 'sender', 'receivedAt', 'sentAt', 'preview',
        'keywords', 'hasAttachment', 'size',
      ]
      const emails = await authStore.client.emailGet(addedIds, props)
      newEmails = normalizeEmails(emails)
    }

    queryClient.setQueryData(queryKey, (oldData) => {
      if (!oldData) return oldData
      return {
        ...oldData,
        pages: oldData.pages.map((page, pageIndex) => {
          if (pageIndex === 0) {
            let updatedList = page.list || []
            if (removed.length > 0) {
              const removedSet = new Set(removed)
              updatedList = updatedList.filter(
                (email) => !removedSet.has(email.id)
              )
            }
            for (const addedItem of added) {
              const { id, index } = addedItem
              const newEmail = newEmails.find((e) => e.id === id)
              if (newEmail && index != null) updatedList.splice(index, 0, newEmail)
            }
            return {
              ...page,
              list: updatedList,
              qr: {
                ...page.qr,
                queryState: newQueryState,
                total: total != null ? total : page.qr?.total,
              },
            }
          }
          return page
        }),
      }
    })
  }

  // ── Delete ──

  async function deleteCurrent() {
    if (!selectedEmailId.value) return
    const emails = emailsFromQuery.value || []
    const m = emails.find((x) => x.id === selectedEmailId.value)
    if (!m) return

    try {
      const wasUnread = !m.isSeen
      const queryKey = [
        'emails',
        currentMailboxId.value,
        sortPropForBox(currentBox.value),
      ]
      queryClient.setQueryData(queryKey, (oldData) => {
        if (!oldData) return oldData
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
        }
      })

      if (wasUnread) {
        const mb = mailboxes.value.find(
          (x) => x.id === currentMailboxId.value
        )
        if (mb && mb.unreadEmails > 0) mb.unreadEmails--
      }

      selectedEmailId.value = null
      clearDetail()
      await authStore.client.moveToTrashOrDestroy(m.id, currentMailboxId.value)
    } catch (e) {
      authStore.error = 'Delete failed: ' + e.message
      await queryClient.invalidateQueries({
        queryKey: [
          'emails',
          currentMailboxId.value,
          sortPropForBox(currentBox.value),
        ],
      })
    }
  }

  // ── CID image resolution ──

  async function resolveCidImages(html, cidMap) {
    const re = /src=["']cid:([^"']+)["']/gi
    let result = html
    let match
    while ((match = re.exec(html))) {
      const cid = match[1]
      const blobId = cidMap?.[cid]
      if (!blobId) continue
      if (!cidUrls[cid]) {
        try {
          const url = authStore.client.makeDownloadUrl(blobId, cid + '.bin')
          const r = await fetch(url, {
            headers: { Authorization: authStore.client.AUTH },
            mode: 'cors',
            credentials: 'omit',
          })
          if (r.ok) {
            const blob = await r.blob()
            cidUrls[cid] = URL.createObjectURL(blob)
          }
        } catch {}
      }
      if (cidUrls[cid]) result = result.replaceAll(`cid:${cid}`, cidUrls[cid])
    }
    return result
  }

  // ── Reply ──

  function ensureReSubject(s) {
    const t = (s || '(no subject)').trim()
    return /^re:/i.test(t) ? t : `Re: ${t}`
  }

  async function replyToCurrent() {
    if (!selectedEmailId.value) return
    const emails = emailsFromQuery.value || []
    const m = emails.find((x) => x.id === selectedEmailId.value)
    if (!m) return

    let quotedHtml = ''
    let quotedText = ''
    try {
      if (bodyHtml.value || bodyText.value) {
        quotedHtml = bodyHtml.value || bodyText.value || m.preview || ''
        quotedText = bodyText.value || m.preview || ''
      } else {
        const info = await authStore.client.emailDetail(m.id)
        quotedHtml = info.html || info.text || m.preview || ''
        quotedText = info.text || m.preview || ''
      }
    } catch (e) {
      console.debug('Failed to fetch email body for reply, using preview:', e)
      quotedHtml = m.preview || ''
      quotedText = m.preview || ''
    }

    const who = m.fromText || 'the sender'
    const when = fmtDate(m.receivedAt || m.sentAt)
    const replyHtml = `<br><br><div style="color: #666;">On ${when}, ${who} wrote:</div><blockquote style="margin: 10px 0 0 10px; padding: 0 0 0 10px; border-left: 2px solid #ccc; color: #666;">${quotedHtml}</blockquote>`
    const replyText = `\n\nOn ${when}, ${who} wrote:\n> ${quotedText.replace(
      /\n/g,
      '\n> '
    )}`

    const { useComposeStore } = await import('./compose-store.js')
    const composeStore = useComposeStore()
    composeStore.prepareReply({
      to: joinAddrs(
        m.replyTo && m.replyTo.length ? m.replyTo : m.from || []
      ),
      subject: ensureReSubject(m.subject),
      html: replyHtml,
      text: replyText,
    })
  }

  // ── Download ──

  function download(a) {
    authStore.client
      .downloadAttachment(a.blobId, a.name, a.type)
      .catch((e) => (authStore.error = 'Download failed: ' + e.message))
  }

  // ── View mode ──

  function setView(mode) {
    if (['all', 'unread'].includes(mode)) viewMode.value = mode
  }

  // ── Periodic delta updates ──

  let deltaUpdateInterval = null

  function startDeltaUpdates() {
    if (deltaUpdateInterval) clearInterval(deltaUpdateInterval)
    deltaUpdateInterval = setInterval(() => {
      if (authStore.connected && currentMailboxId.value)
        checkForDeltaUpdates()
    }, 30_000)
  }

  function handleWindowFocus() {
    if (authStore.connected && currentMailboxId.value)
      checkForDeltaUpdates()
  }

  return {
    mailboxes,
    currentMailboxId,
    selectedEmailId,
    initialized,
    viewMode,
    filterText,
    detail,
    attachments,
    bodyHtml,
    bodyText,
    currentBox,
    visibleMessages,
    emailsFromQuery,
    totalEmailsCount,
    displayName,
    getMailboxUrlName,
    resolveMailboxByName,
    initialize,
    switchMailbox,
    switchMailboxByName,
    selectMessage,
    backToList,
    refreshCurrentMailbox,
    deleteCurrent,
    replyToCurrent,
    download,
    setView,
    onVirtRange,
    handleWindowFocus,
    sortPropForBox,
    fmtDate,
    joinAddrs,
  }
})
