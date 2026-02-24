import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { useAuthStore } from './auth-store.js'

export const useComposeStore = defineStore('compose', () => {
  const authStore = useAuthStore()

  const identities = ref([])
  const sending = ref(false)
  const composeStatus = ref('')
  const composeDebug = ref('')
  const compose = reactive({
    fromIdx: 0,
    to: '',
    subject: '',
    html: '',
    text: '',
  })

  async function loadIdentities() {
    if (!authStore.client) return
    identities.value = await authStore.client.listIdentities()
  }

  function resetCompose() {
    compose.fromIdx = 0
    compose.to = ''
    compose.subject = ''
    compose.html = ''
    compose.text = ''
    composeStatus.value = ''
    composeDebug.value = ''
  }

  function prepareReply({ to, subject, html, text }) {
    compose.to = to
    compose.subject = subject
    compose.html = html
    compose.text = text
    composeStatus.value = ''
    composeDebug.value = ''
  }

  function parseAddrList(input) {
    return (input || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/^(.+?)\s*<(.+?)>$/)
        return m
          ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() }
          : { email: p }
      })
  }

  function sanitizeForDebug(obj) {
    const copy = JSON.parse(JSON.stringify(obj))
    try {
      const calls = copy.methodCalls || []
      for (const c of calls) {
        if (c[0] === 'Email/set' && c[1]?.create) {
          for (const k of Object.keys(c[1].create)) {
            if (c[1].create[k]?.bodyValues) {
              for (const pid of Object.keys(c[1].create[k].bodyValues)) {
                const v = c[1].create[k].bodyValues[pid].value || ''
                c[1].create[k].bodyValues[pid].value =
                  v.length > 500 ? v.slice(0, 500) + '…[truncated]' : v
              }
            }
          }
        }
      }
    } catch {}
    return copy
  }

  function extractMethodErrors(json) {
    if (!json) return ''
    const issues = []
    try {
      for (const [name, payload] of json.methodResponses || []) {
        ;['notCreated', 'notUpdated', 'notDestroyed', 'notSubmitted'].forEach(
          (k) => {
            if (payload?.[k]) {
              Object.entries(payload[k]).forEach(([id, err]) => {
                issues.push(
                  `${name}/${k}/${id}: ${err.type || 'error'} - ${
                    err.description || 'unknown'
                  }`
                )
              })
            }
          }
        )
      }
    } catch {}
    return issues.join('\n')
  }

  async function send() {
    if (!identities.value.length) {
      composeStatus.value = 'No identities.'
      return false
    }
    const id = identities.value[compose.fromIdx] || identities.value[0]
    const from = {
      email: (id.email || '').trim(),
      name: (id.name || '').trim() || undefined,
    }
    const toList = parseAddrList(compose.to)
    if (!from.email || !id.id) {
      composeStatus.value = 'From/Identity missing.'
      return false
    }
    if (!toList.length) {
      composeStatus.value = 'Add at least one recipient.'
      return false
    }

    try {
      sending.value = true
      composeStatus.value = 'Sending…'
      composeDebug.value = ''

      const res = await authStore.client.sendMultipartAlternative({
        from,
        identityId: id.id,
        toList,
        subject: compose.subject || '',
        text: compose.text || '',
        html: compose.html || '',
        draftsId: authStore.client.ids.drafts,
        sentId: authStore.client.ids.sent,
      })

      const methodIssues = extractMethodErrors(res.json)
      composeDebug.value = `Started: ${res.started}\nStatus: ${res.status} ${
        res.statusText
      }\n\nRequest:\n${JSON.stringify(
        sanitizeForDebug(JSON.parse(res.req)),
        null,
        2
      )}\n\nResponse:\n${res.text}${
        methodIssues ? '\nMethod issues:\n' + methodIssues : ''
      }`

      if (!res.ok) {
        composeStatus.value = `Send failed: ${res.status} ${res.statusText}`
        return false
      }
      if (methodIssues) {
        const firstLine =
          String(methodIssues).split('\n').find(Boolean) ||
          'Unknown method error'
        composeStatus.value = 'Send may have failed: ' + firstLine
        return false
      }
      composeStatus.value = 'Sent.'
      resetCompose()
      return true
    } catch (e) {
      composeStatus.value = 'Send failed: ' + e.message
      return false
    } finally {
      sending.value = false
    }
  }

  return {
    identities,
    sending,
    composeStatus,
    composeDebug,
    compose,
    loadIdentities,
    resetCompose,
    prepareReply,
    send,
  }
})
