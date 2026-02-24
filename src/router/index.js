import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth-store.js'

const LoginView = () => import('../views/LoginView/LoginView.vue')
const MailboxView = () => import('../views/MailboxView/MailboxView.vue')

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
  },
  {
    path: '/mailbox/:folderName/compose',
    name: 'compose',
    component: MailboxView,
  },
  {
    path: '/mailbox/:folderName?',
    name: 'mailbox',
    component: MailboxView,
  },
  {
    path: '/',
    redirect: '/mailbox',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const authStore = useAuthStore()

  if (to.name !== 'login' && !authStore.connected) {
    return { name: 'login' }
  }

  if (to.name === 'login' && authStore.connected) {
    return { name: 'mailbox', params: { folderName: 'inbox' } }
  }

  if ((to.name === 'mailbox' || to.name === 'compose') && !to.params.folderName) {
    return { name: 'mailbox', params: { folderName: 'inbox' } }
  }
})

export default router
