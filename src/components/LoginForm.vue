<script>
import { ref } from 'vue'

export default {
  name: 'LoginForm',
  props: {
    connected: Boolean,
    status: String,
    error: String
  },
  emits: ['connect'],
  setup(props, { emit }) {
    const username = ref('')
    const password = ref('')

    const connect = () => {
      emit('connect', { username: username.value, password: password.value })
    }

    return {
      username,
      password,
      connect
    }
  }
}
</script>

<template>
  <section id="auth" v-if="!connected">
    <div class="card">
      <img class="logo" src="https://www.thunderbird.net/media/svg/logo.svg" alt="Thunderbird logo">
      <h1>Thundermail</h1>
      <div class="sub">Sign in with your username and app password.</div>
      <div class="row">
        <input v-model.trim="username" placeholder="Username" autocomplete="username" />
        <input v-model="password" placeholder="App password" type="password" autocomplete="current-password" />
        <button @click="connect">Connect</button>
      </div>
      <div id="authMeta" class="meta">{{ status }}</div>
      <div id="authErr" class="err" v-if="error">{{ error }}</div>
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
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
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
  padding: .65rem .8rem;
  border: 1px solid var(--border);
  border-radius: .6rem;
  background: var(--panel2);
  color: var(--text);
}

button {
  padding: .7rem .95rem;
  border: 0;
  border-radius: .6rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  width: 100%;
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
