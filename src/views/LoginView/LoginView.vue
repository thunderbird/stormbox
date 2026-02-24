<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth-store.js'
import { useEmailStore } from '../../stores/email-store.js'

const router = useRouter()
const authStore = useAuthStore()
const emailStore = useEmailStore()

const username = ref('')
const password = ref('')
const showAppPassword = ref(false)
const connecting = ref(false)

async function postLogin() {
  await emailStore.initialize()
  router.push({ name: 'mailbox', params: { folderName: 'inbox' } })
}

async function handleOAuthLogin() {
  connecting.value = true
  try {
    const success = await authStore.handleOAuthLogin()
    if (success) await postLogin()
  } finally {
    connecting.value = false
  }
}

async function handleConnect() {
  connecting.value = true
  try {
    const success = await authStore.connect({
      username: username.value,
      password: password.value,
    })
    if (success) await postLogin()
  } finally {
    connecting.value = false
  }
}

onMounted(async () => {
  const oidc = await authStore.initializeOidc()
  if (oidc?.isUserLoggedIn) {
    connecting.value = true
    try {
      const success = await authStore.connectWithOAuth(oidc)
      if (success) await postLogin()
    } finally {
      connecting.value = false
    }
  }
})
</script>

<template>
  <section id="auth">
    <div class="card">
      <img
        class="logo"
        src="https://www.thunderbird.net/media/svg/logo.svg"
        alt="Thunderbird logo"
      />
      <h1>Thundermail</h1>

      <div v-if="!showAppPassword" class="oauth-section">
        <div class="sub">Sign in with your Thunderbird account.</div>
        <button
          class="oauth-btn"
          @click="handleOAuthLogin"
          :disabled="!authStore.oidcReady || authStore.oidcLoading || connecting"
        >
          <span v-if="authStore.oidcLoading">Initializing...</span>
          <span v-else-if="connecting">Connecting...</span>
          <span v-else>Sign in with Thunderbird</span>
        </button>
        <button class="link-btn" @click="showAppPassword = true">
          Use app password instead
        </button>
      </div>

      <div v-else>
        <div class="sub">Sign in with your username and app password.</div>
        <div class="row">
          <input
            v-model.trim="username"
            placeholder="Username"
            autocomplete="username"
          />
          <input
            v-model="password"
            placeholder="App password"
            type="password"
            autocomplete="current-password"
          />
          <button @click="handleConnect" :disabled="connecting">
            {{ connecting ? 'Connecting...' : 'Connect' }}
          </button>
        </div>
        <button class="link-btn" @click="showAppPassword = false">
          Sign in with Thunderbird account
        </button>
      </div>

      <div id="authMeta" class="meta">{{ authStore.status }}</div>
      <div id="authErr" class="err" v-if="authStore.error">
        {{ authStore.error }}
      </div>
    </div>
  </section>
</template>

<style scoped>
#auth {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.card {
  width: min(460px, 92vw);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 22px 22px 18px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}

.logo {
  display: block;
  margin: 2px auto 10px;
  width: 84px;
  height: auto;
}

h1 {
  margin: 0 0 6px 0;
  font-size: 26px;
  text-align: center;
}

.sub {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 14px;
  text-align: center;
}

.row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-bottom: 8px;
}

input {
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--panel2);
  color: var(--text);
}

.oauth-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.oauth-btn {
  padding: 0.8rem 1.2rem;
  border: 0;
  border-radius: 0.6rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  width: 100%;
  font-size: 15px;
  font-weight: 500;
}

.oauth-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

button {
  padding: 0.7rem 0.95rem;
  border: 0;
  border-radius: 0.6rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  width: 100%;
}

.link-btn {
  background: none;
  color: var(--muted);
  font-size: 12px;
  padding: 4px;
  cursor: pointer;
  border: 0;
  text-decoration: underline;
  width: auto;
}

.link-btn:hover {
  color: var(--text);
}

.meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 6px;
  text-align: center;
}

.err {
  color: #ff6b6b;
  white-space: pre-wrap;
  font-size: 13px;
  margin-top: 6px;
  text-align: center;
}
</style>
