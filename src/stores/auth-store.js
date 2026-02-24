import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { initOidc, getOidc } from '../services/auth.js'
import { JMAPClient } from '../services/jmap.js'
import { JMAP_SERVER_URL } from '../defines.js'

export const useAuthStore = defineStore('auth', () => {
  const client = ref(null)
  const connected = ref(false)
  const status = ref('Not connected.')
  const error = ref('')
  const oidcReady = ref(false)
  const oidcLoading = ref(true)

  const serverName = computed(() => {
    try {
      return new URL(JMAP_SERVER_URL).hostname
    } catch {
      return JMAP_SERVER_URL
    }
  })

  async function initializeOidc() {
    try {
      const oidc = await initOidc()
      oidcReady.value = true
      oidcLoading.value = false
      return oidc
    } catch (e) {
      console.error('OIDC initialization failed:', e)
      oidcLoading.value = false
      return null
    }
  }

  async function connect(credentials) {
    if (!credentials?.username || !credentials?.password) {
      error.value = 'Username and password required.'
      return false
    }
    error.value = ''
    status.value = 'Connecting…'
    try {
      client.value = new JMAPClient({
        baseUrl: JMAP_SERVER_URL,
        username: credentials.username.trim(),
        password: credentials.password,
      })
      await client.value.fetchSession()
      localStorage.setItem('jmap.username', credentials.username.trim())
      connected.value = true
      document.body.classList.add('connected')
      return true
    } catch (e) {
      status.value = 'Failed.'
      error.value =
        e.message +
        (e.message?.includes('Failed to fetch')
          ? '\nLikely CORS/network issue.'
          : '')
      return false
    }
  }

  async function connectWithOAuth(oidc) {
    error.value = ''
    status.value = 'Connecting with OAuth…'
    try {
      client.value = new JMAPClient({
        baseUrl: JMAP_SERVER_URL,
        getToken: async () => {
          const { accessToken } = await oidc.getTokens()
          return accessToken
        },
      })
      await client.value.fetchSession()
      connected.value = true
      document.body.classList.add('connected')
      return true
    } catch (e) {
      status.value = 'Failed.'
      error.value =
        e.message +
        (e.message?.includes('Failed to fetch')
          ? '\nLikely CORS/network issue.'
          : '')
      return false
    }
  }

  async function handleOAuthLogin() {
    const oidc = getOidc()
    if (!oidc) return false
    if (!oidc.isUserLoggedIn) {
      await oidc.login()
      return false
    }
    return await connectWithOAuth(oidc)
  }

  async function handleLogout() {
    const oidc = getOidc()
    if (oidc && oidc.isUserLoggedIn) {
      await oidc.logout({ redirectTo: 'home' })
    } else {
      window.location.reload()
    }
  }

  return {
    client,
    connected,
    status,
    error,
    oidcReady,
    oidcLoading,
    serverName,
    initializeOidc,
    connect,
    connectWithOAuth,
    handleOAuthLogin,
    handleLogout,
  }
})
